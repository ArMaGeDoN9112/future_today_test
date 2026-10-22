import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogVersion, getCatalogEntry, searchCatalog } from './catalogs.js';

/** @typedef {{id: string, type: string, label: string, required: boolean, options?: string[]}} Field */
/** @typedef {{id: string, title: string, fields: Field[], status: 'draft' | 'published' | 'closed', publicUrl: string | null}} Form */
/** @type {Form[]} */
let forms = [];
const dataDirectory = resolve('data');
const storagePath = resolve(dataDirectory, 'forms.json');

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Ожидается JSON-объект.');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} input @param {boolean} partial @returns {Partial<Pick<Form, 'title' | 'fields'>>} */
function content(input, partial) {
  const body = object(input);
  if (Object.keys(body).some(key => !['title', 'fields'].includes(key)) || !Object.keys(body).length) {
    throw new HttpError(400, 'Допустимы только title и fields.');
  }
  if ((!partial || 'title' in body) && !nonempty(body.title)) {
    throw new HttpError(400, 'Название формы должно быть непустой строкой.');
  }
  if (!partial || 'fields' in body) {
    if (!Array.isArray(body.fields)) throw new HttpError(400, 'fields должен быть массивом.');
    const ids = new Set();
    for (const value of body.fields) {
      const field = object(value);
      if (!nonempty(field.id) || ids.has(field.id) || !nonempty(field.label) || typeof field.required !== 'boolean') {
        throw new HttpError(400, 'У поля нужны уникальный непустой id, подпись label и required (boolean).');
      }
      ids.add(field.id);
      if (!['short_text', 'long_text', 'email', 'single_choice', 'city', 'university', 'study_direction', 'study_level_course'].includes(/** @type {string} */ (field.type))) {
        throw new HttpError(400, 'Неизвестный тип поля.');
      }
      const allowed = ['id', 'type', 'label', 'required', ...(field.type === 'single_choice' ? ['options'] : [])];
      if (Object.keys(field).some(key => !allowed.includes(key))) throw new HttpError(400, 'Неизвестные свойства поля.');
      if (field.type === 'single_choice' && (!Array.isArray(field.options) || !field.options.length ||
          field.options.some(option => !nonempty(option)) || new Set(field.options.map(option => option.trim())).size !== field.options.length)) {
        throw new HttpError(400, 'Для single_choice нужны непустые уникальные строки options.');
      }
    }
  }
  return /** @type {Partial<Pick<Form, 'title' | 'fields'>>} */ (body);
}

try {
  const saved = JSON.parse(readFileSync(storagePath, 'utf8'));
  if (!Array.isArray(saved)) throw new Error('Хранилище должно содержать массив форм.');
  const ids = new Set();
  const links = new Set();
  for (const form of saved) {
    object(form);
    content({ title: form.title, fields: form.fields }, false);
    if (!nonempty(form.id) || ids.has(form.id) || !['draft', 'published', 'closed'].includes(form.status) ||
        (form.status === 'draft' ? form.publicUrl !== null :
          typeof form.publicUrl !== 'string' || !/^\/forms\/[\w-]+$/.test(form.publicUrl) || links.has(form.publicUrl))) {
      throw new Error('Некорректная структура сохранённой формы.');
    }
    ids.add(form.id);
    if (form.publicUrl) links.add(form.publicUrl);
  }
  forms = saved;
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
}

/** @param {Form[]} next */
function save(next) {
  // shortcut: синхронный JSON рассчитан на один процесс и небольшой объём; при росте нужно транзакционное хранилище.
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(next));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporaryPath, storagePath);
    forms = next;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** @param {import('node:http').IncomingMessage} request */
async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Используйте Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Размер запроса превышает 1 МиБ.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Некорректный JSON.'); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const catalogMatch = path.match(/^\/api\/catalogs\/(cities|universities|study-directions|study-courses)(?:\/([^/]+))?$/);
    let result;
    let status = 200;
    if (catalogMatch) {
      if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
      const kind = /** @type {import('./catalogs.js').CatalogKind} */ (catalogMatch[1]);
      if (catalogMatch[2]) {
        const item = getCatalogEntry(kind, catalogMatch[2]);
        if (!item) throw new HttpError(404, 'Значение справочника не найдено.');
        result = { version: catalogVersion, item };
      } else {
        let level;
        if (kind === 'study-courses' && url.searchParams.has('directionId')) {
          const direction = getCatalogEntry('study-directions', url.searchParams.get('directionId') ?? '');
          if (!direction) throw new HttpError(404, 'Направление обучения не найдено.');
          level = direction.level;
        }
        result = { version: catalogVersion, items: searchCatalog(kind, url.searchParams.get('q') ?? '', level) };
      }
    } else if (path === '/api/forms' && request.method === 'GET') {
      result = forms;
    } else if (path === '/api/forms' && request.method === 'POST') {
      const body = content(await readBody(request), false);
      const form = /** @type {Form} */ ({ id: randomUUID(), ...body, status: 'draft', publicUrl: null });
      save([...forms, form]);
      result = form;
      status = 201;
    } else {
      const publicMatch = path.match(/^\/forms\/([^/]+)$/);
      const match = path.match(/^\/api\/forms\/([^/]+)(?:\/(publish|close|reopen))?$/);
      if (!match && !publicMatch) throw new HttpError(404, 'Маршрут не найден.');
      const body = match && !match[2] && request.method === 'PATCH' ? content(await readBody(request), true) : undefined;
      const form = forms.find(form => publicMatch ? form.publicUrl === path : form.id === match?.[1]);
      if (!form) throw new HttpError(404, 'Форма не найдена.');
      if (publicMatch) {
        if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        result = form.status === 'closed' ? { ...form, message: 'Приём завершён' } : form;
      } else if (!match?.[2] && request.method === 'GET') {
        result = form;
      } else if (body) {
        if (form.status !== 'draft') throw new HttpError(409, 'Содержание опубликованной формы нельзя изменять.');
        const updated = { ...form, ...body };
        save(forms.map(item => item.id === form.id ? updated : item));
        result = updated;
      } else if (match?.[2] && request.method === 'POST') {
        const action = match[2];
        const expected = { publish: 'draft', close: 'published', reopen: 'closed' }[action];
        if (form.status !== expected) throw new HttpError(409, 'Этот переход недоступен в текущем состоянии формы.');
        const updated = {
          ...form,
          status: /** @type {Form['status']} */ (action === 'close' ? 'closed' : 'published'),
          publicUrl: form.publicUrl ?? `/forms/${randomUUID()}`,
        };
        save(forms.map(item => item.id === form.id ? updated : item));
        result = updated;
      } else {
        throw new HttpError(405, 'Метод не поддерживается.');
      }
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : 'Не удалось сохранить или обработать данные.' }));
  }
});

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT должен быть целым числом от 0 до 65535.');
server.listen(port, 'localhost', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`http://localhost:${address.port}`);
});
