import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogVersion, getCatalogEntry, searchCatalog } from './catalogs.js';

/** @typedef {{id: string, type: string, label: string, required: boolean, options?: string[]}} Field */
/** @typedef {{id: string, title: string, fields: Field[], status: 'draft' | 'published' | 'closed', publicUrl: string | null}} Form */
/** @typedef {{id: string, formId: string, attemptId?: string, submittedAt: string, catalogVersion: string, answers: Record<string, string | Readonly<import('./catalogs.js').CatalogEntry>>}} FormResponse */
/** @typedef {{id: string, formId: string, createdAt: string, startedAt: string | null, lastActiveAt: string, lastFieldId: string | null}} Attempt */
/** @type {Form[]} */
let forms = [];
/** @type {FormResponse[]} */
let responses = [];
/** @type {Attempt[]} */
let attempts = [];
const dataDirectory = resolve('data');
const storagePath = resolve(dataDirectory, 'forms.json');
const responsesPath = resolve(dataDirectory, 'responses.json');
const attemptsPath = resolve(dataDirectory, 'attempts.json');
/** @type {Record<string, import('./catalogs.js').CatalogKind>} */
const fieldCatalogs = { city: 'cities', university: 'universities', study_direction: 'study-directions', study_level_course: 'study-courses' };

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

try {
  const saved = JSON.parse(readFileSync(responsesPath, 'utf8'));
  if (!Array.isArray(saved)) throw new Error('Хранилище должно содержать массив откликов.');
  const ids = new Set();
  for (const response of saved) {
    object(response);
    const form = forms.find(form => form.id === response.formId && form.status !== 'draft');
    if (!nonempty(response.id) || ids.has(response.id) || !form || !nonempty(response.catalogVersion) ||
        typeof response.submittedAt !== 'string' || !Number.isFinite(Date.parse(response.submittedAt))) {
      throw new Error('Некорректная структура сохранённого отклика.');
    }
    const answers = object(response.answers);
    if (Object.keys(answers).some(id => !form.fields.some(field => field.id === id))) {
      throw new Error('Сохранённый ответ не соответствует полям формы.');
    }
    for (const field of form.fields) {
      if (!Object.hasOwn(answers, field.id)) {
        if (field.required) throw new Error('В сохранённом отклике отсутствует обязательный ответ.');
        continue;
      }
      const value = answers[field.id];
      if (Object.hasOwn(fieldCatalogs, field.type)) {
        const entry = object(value);
        if (!nonempty(entry.id) || !nonempty(entry.name)) throw new Error('Повреждён сохранённый справочный ответ.');
      } else if (typeof value !== 'string') {
        throw new Error('Повреждён сохранённый текстовый ответ.');
      }
    }
    ids.add(response.id);
  }
  responses = saved;
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
}

try {
  const saved = JSON.parse(readFileSync(attemptsPath, 'utf8'));
  if (!Array.isArray(saved)) throw new Error('Хранилище должно содержать массив попыток.');
  const ids = new Set();
  for (const attempt of saved) {
    object(attempt);
    const form = forms.find(form => form.id === attempt.formId && form.status !== 'draft');
    if (!nonempty(attempt.id) || ids.has(attempt.id) || !form ||
        ![attempt.createdAt, attempt.lastActiveAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ||
        (attempt.startedAt !== null && (typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt)))) ||
        (attempt.lastFieldId !== null && !form.fields.some(field => field.id === attempt.lastFieldId))) {
      throw new Error('Некорректная структура сохранённой попытки.');
    }
    ids.add(attempt.id);
  }
  attempts = saved;
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
}

const completedIds = new Set();
for (const response of responses) {
  if (!Object.hasOwn(response, 'attemptId')) continue;
  if (!nonempty(response.attemptId) || completedIds.has(response.attemptId) ||
      !attempts.some(attempt => attempt.id === response.attemptId && attempt.formId === response.formId)) {
    throw new Error('Некорректная связь сохранённого отклика с попыткой.');
  }
  completedIds.add(response.attemptId);
}

/** @param {Form} form @param {unknown} id */
function findAttempt(form, id) {
  if (!nonempty(id)) throw new HttpError(400, 'Передайте непустой attemptId.');
  const attempt = attempts.find(attempt => attempt.id === id && attempt.formId === form.id);
  if (!attempt) throw new HttpError(404, 'Попытка этой формы не найдена.');
  return attempt;
}

/** @param {string} path @param {Form[] | FormResponse[] | Attempt[]} next */
function save(path, next) {
  // shortcut: синхронный JSON рассчитан на один процесс и небольшой объём; при росте нужно транзакционное хранилище.
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(next));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** @param {Form} form @param {unknown} input @returns {FormResponse['answers']} */
function validateAnswers(form, input) {
  const body = object(input);
  if (Object.keys(body).some(key => !['answers', 'attemptId'].includes(key)) || !Object.hasOwn(body, 'answers')) {
    throw new HttpError(400, 'Передайте answers — объект ответов по id полей, и при необходимости attemptId.');
  }
  const answers = object(body.answers);
  if (Object.keys(answers).some(id => !form.fields.some(field => field.id === id))) {
    throw new HttpError(400, 'Ответ содержит неизвестное поле.');
  }
  /** @type {FormResponse['answers']} */
  const result = Object.create(null);
  for (const field of form.fields) {
    if (!Object.hasOwn(answers, field.id)) {
      if (field.required) throw new HttpError(400, `Заполните обязательное поле «${field.label}».`);
      continue;
    }
    const value = answers[field.id];
    if (typeof value !== 'string' || !value.trim()) {
      throw new HttpError(400, `Поле «${field.label}» должно содержать непустую строку.`);
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new HttpError(400, `Введите корректный email в поле «${field.label}».`);
    }
    if (field.type === 'single_choice' && !field.options?.includes(value)) {
      throw new HttpError(400, `Выберите допустимый вариант поля «${field.label}».`);
    }
    let accepted = /** @type {string | Readonly<import('./catalogs.js').CatalogEntry>} */ (value);
    if (Object.hasOwn(fieldCatalogs, field.type)) {
      const entry = getCatalogEntry(fieldCatalogs[field.type], value);
      if (!entry) throw new HttpError(400, `Выберите значение из справочника для поля «${field.label}».`);
      accepted = entry;
    }
    result[field.id] = accepted;
  }
  const directions = form.fields.filter(field => field.type === 'study_direction').map(field => result[field.id]);
  const courses = form.fields.filter(field => field.type === 'study_level_course').map(field => result[field.id]);
  if (directions.some(direction => typeof direction === 'object' && courses.some(course =>
    typeof course === 'object' && direction.level !== course.level))) {
    throw new HttpError(400, 'Уровни направления и курса обучения должны совпадать.');
  }
  return result;
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
    const asset = {
      '/admin': ['admin.html', 'text/html'],
      '/admin/admin.js': ['admin.js', 'text/javascript'],
      '/admin/admin.css': ['admin.css', 'text/css'],
    }[path];
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается.');
      const data = readFileSync(new URL(`./admin/${asset[0]}`, import.meta.url));
      response.writeHead(200, {
        'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : data);
      return;
    }
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
      const next = [...forms, form];
      save(storagePath, next);
      forms = next;
      result = form;
      status = 201;
    } else {
      const publicMatch = path.match(/^\/forms\/([^/]+)(?:\/(responses|attempts)(?:\/([^/]+)\/(events))?)?$/);
      const match = path.match(/^\/api\/forms\/([^/]+)(?:\/(publish|close|reopen|responses|analytics))?$/);
      if (!match && !publicMatch) throw new HttpError(404, 'Маршрут не найден.');
      if (publicMatch?.[3] && publicMatch[2] !== 'attempts') throw new HttpError(404, 'Маршрут не найден.');
      const input = publicMatch?.[2] && request.method === 'POST' ? await readBody(request) : undefined;
      const body = match && !match[2] && request.method === 'PATCH' ? content(await readBody(request), true) : undefined;
      const form = forms.find(form => publicMatch ? form.publicUrl === `/forms/${publicMatch[1]}` : form.id === match?.[1]);
      if (!form) throw new HttpError(404, 'Форма не найдена.');
      if (publicMatch?.[2] === 'attempts') {
        if (request.method !== 'POST') throw new HttpError(405, 'Метод не поддерживается.');
        const event = object(input);
        if (publicMatch[4]) {
          const attempt = findAttempt(form, publicMatch[3]);
          if (!['change', 'focus', 'activity'].includes(/** @type {string} */ (event.type)) ||
              Object.keys(event).some(key => !['type', ...(event.type === 'activity' ? [] : ['fieldId'])].includes(key)) ||
              (event.type !== 'activity' && !form.fields.some(field => field.id === event.fieldId))) {
            throw new HttpError(400, 'Передайте тип события и id поля этой формы без содержимого ответа.');
          }
          if (responses.some(response => response.attemptId === attempt.id)) {
            result = attempt;
          } else {
            const now = new Date(Date.now()).toISOString();
            const startedAt = attempt.startedAt ?? (event.type === 'change' ? now : null);
            const updated = { ...attempt, startedAt, lastActiveAt: now,
              lastFieldId: startedAt && event.type !== 'activity' ? /** @type {string} */ (event.fieldId) : attempt.lastFieldId };
            const next = attempts.map(item => item.id === attempt.id ? updated : item);
            save(attemptsPath, next);
            attempts = next;
            result = updated;
          }
        } else {
          if (Object.keys(event).some(key => key !== 'attemptId')) throw new HttpError(400, 'Допустим только attemptId.');
          if (Object.hasOwn(event, 'attemptId')) {
            result = findAttempt(form, event.attemptId);
          } else {
            if (form.status !== 'published') throw new HttpError(409, 'Приём откликов недоступен.');
            const now = new Date(Date.now()).toISOString();
            const attempt = { id: randomUUID(), formId: form.id, createdAt: now, startedAt: null, lastActiveAt: now, lastFieldId: null };
            const next = [...attempts, attempt];
            save(attemptsPath, next);
            attempts = next;
            result = attempt;
            status = 201;
          }
        }
      } else if (publicMatch?.[2] === 'responses') {
        if (request.method !== 'POST') throw new HttpError(405, 'Метод не поддерживается.');
        if (form.status !== 'published') throw new HttpError(409, 'Приём откликов недоступен.');
        const body = object(input);
        const attempt = Object.hasOwn(body, 'attemptId') ? findAttempt(form, body.attemptId) : undefined;
        const answers = validateAnswers(form, body);
        const existing = attempt && responses.find(response => response.attemptId === attempt.id);
        if (existing) {
          result = existing;
        } else {
          const accepted = { id: randomUUID(), formId: form.id, submittedAt: new Date(Date.now()).toISOString(),
            ...(attempt ? { attemptId: attempt.id } : {}), catalogVersion, answers };
          const next = [...responses, accepted];
          save(responsesPath, next);
          responses = next;
          result = accepted;
          status = 201;
        }
      } else if (match?.[2] === 'analytics') {
        if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        const visits = attempts.filter(attempt => attempt.formId === form.id);
        const started = visits.filter(attempt => attempt.startedAt !== null);
        const submitted = responses.filter(response => response.formId === form.id);
        const completed = new Set(submitted.map(response => response.attemptId));
        const pending = started.filter(attempt => !completed.has(attempt.id));
        const abandoned = pending.filter(attempt => Date.now() - Date.parse(attempt.lastActiveAt) >= 30 * 60 * 1000);
        result = { formId: form.id, views: visits.length, starts: started.length,
          submissions: submitted.length,
          inProgress: pending.length - abandoned.length, abandoned: abandoned.length,
          lastActiveFields: abandoned.map(attempt => ({ attemptId: attempt.id, fieldId: attempt.lastFieldId,
            label: form.fields.find(field => field.id === attempt.lastFieldId)?.label, lastActiveAt: attempt.lastActiveAt })) };
      } else if (match?.[2] === 'responses') {
        if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        const items = responses.filter(response => response.formId === form.id);
        result = { formId: form.id, fields: form.fields, count: items.length, responses: items };
      } else if (publicMatch) {
        if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        result = form.status === 'closed' ? { ...form, message: 'Приём завершён' } : form;
      } else if (!match?.[2] && request.method === 'GET') {
        result = form;
      } else if (body) {
        if (form.status !== 'draft') throw new HttpError(409, 'Содержание опубликованной формы нельзя изменять.');
        const updated = { ...form, ...body };
        const next = forms.map(item => item.id === form.id ? updated : item);
        save(storagePath, next);
        forms = next;
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
        const next = forms.map(item => item.id === form.id ? updated : item);
        save(storagePath, next);
        forms = next;
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
