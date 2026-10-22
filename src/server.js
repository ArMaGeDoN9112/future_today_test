import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { catalogVersion, getCatalogEntry, searchCatalog } from './catalogs.js';
import { database, readForm, readResponse } from './storage.js';

/** @typedef {{id: string, type: string, label: string, required: boolean, options?: string[]}} Field */
/** @typedef {{id: string, title: string, fields: Field[], status: 'draft' | 'published' | 'closed', publicUrl: string | null}} Form */
/** @typedef {{id: string, formId: string, attemptId?: string, submittedAt: string, viewed: boolean, catalogVersion: string, answers: Record<string, string | string[] | Readonly<import('./catalogs.js').CatalogEntry>>}} FormResponse */
/** @typedef {{id: string, formId: string, createdAt: string, startedAt: string | null, lastActiveAt: string, lastFieldId: string | null}} Attempt */
/** @typedef {'change' | 'focus' | 'activity' | 'invalid_format' | 'required_missing' | 'search_empty' | 'catalog_error' | 'submit' | 'validation_failed' | 'request_failed'} EventType */
const fieldIssues = ['invalid_format', 'required_missing', 'search_empty', 'catalog_error'];
const submissionEvents = ['submit', 'validation_failed', 'request_failed'];
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
      if (!['short_text', 'long_text', 'email', 'single_choice', 'multiple_choice', 'city', 'university', 'study_direction', 'study_level_course'].includes(/** @type {string} */ (field.type))) {
        throw new HttpError(400, 'Неизвестный тип поля.');
      }
      const choice = field.type === 'single_choice' || field.type === 'multiple_choice';
      const allowed = ['id', 'type', 'label', 'required', ...(choice ? ['options'] : [])];
      if (Object.keys(field).some(key => !allowed.includes(key))) throw new HttpError(400, 'Неизвестные свойства поля.');
      if (choice && (!Array.isArray(field.options) || !field.options.length ||
          field.options.some(option => !nonempty(option)) || new Set(field.options.map(option => option.trim())).size !== field.options.length)) {
        throw new HttpError(400, `Для ${field.type} нужны непустые уникальные строки options.`);
      }
    }
  }
  return /** @type {Partial<Pick<Form, 'title' | 'fields'>>} */ (body);
}

/** @param {Form} form @param {unknown} id */
function findAttempt(form, id) {
  if (!nonempty(id)) throw new HttpError(400, 'Передайте непустой attemptId.');
  const attempt = /** @type {Attempt | undefined} */ (database.prepare('SELECT * FROM attempts WHERE id = ? AND formId = ?').get(id, form.id));
  if (!attempt) throw new HttpError(404, 'Попытка этой формы не найдена.');
  return attempt;
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
    if (field.type === 'multiple_choice') {
      if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
          value.some(option => typeof option !== 'string' || !field.options?.includes(option))) {
        throw new HttpError(400, `Выберите допустимые варианты без повторов для поля «${field.label}».`);
      }
      result[field.id] = value;
      continue;
    }
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
  if (directions.some(direction => typeof direction === 'object' && !Array.isArray(direction) && courses.some(course =>
    typeof course === 'object' && !Array.isArray(course) && direction.level !== course.level))) {
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
      '/admin': ['admin/admin.html', 'text/html'],
      '/admin/admin.js': ['admin/admin.js', 'text/javascript'],
      '/admin/admin.css': ['admin/admin.css', 'text/css'],
      '/student/student.js': ['student/student.js', 'text/javascript'],
      '/student/student.css': ['student/student.css', 'text/css'],
    }[path];
    const studentPage = /^\/forms\/[^/]+$/.test(path) && request.headers.accept?.includes('text/html');
    if (asset || studentPage) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается.');
      const [file, mime] = asset ?? ['student/student.html', 'text/html'];
      const data = readFileSync(new URL(`./${file}`, import.meta.url));
      response.writeHead(200, {
        'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store', 'Vary': 'Accept',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : data);
      return;
    }
    const catalogMatch = path.match(/^\/api\/catalogs\/(cities|universities|study-directions|study-courses)(?:\/([^/]+))?$/);
    const publicMatch = path.match(/^\/forms\/([^/]+)(?:\/(responses|attempts)(?:\/([^/]+)\/(events))?)?$/);
    const match = path.match(/^\/api\/forms\/([^/]+)(?:\/(publish|close|reopen|responses|analytics)(?:\/([^/]+))?)?$/);
    if (match?.[3] && match[2] !== 'responses') throw new HttpError(404, 'Маршрут не найден.');
    if (publicMatch?.[3] && publicMatch[2] !== 'attempts') throw new HttpError(404, 'Маршрут не найден.');
    const input = (publicMatch?.[2] && request.method === 'POST') ||
      (path === '/api/forms' && request.method === 'POST') ||
      (match && (!match[2] || match[3]) && request.method === 'PATCH') ? await readBody(request) : undefined;
    const execute = () => {
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
        result = database.prepare('SELECT * FROM forms ORDER BY rowid').all().map(readForm);
      } else if (path === '/api/forms' && request.method === 'POST') {
        const body = content(input, false);
        const form = /** @type {Form} */ ({ id: randomUUID(), ...body, status: 'draft', publicUrl: null });
        database.prepare('INSERT INTO forms (id, title, fields, status, publicUrl) VALUES (?, ?, ?, ?, ?)')
          .run(form.id, form.title, JSON.stringify(form.fields), form.status, form.publicUrl);
        result = form;
        status = 201;
      } else {
        if (!match && !publicMatch) throw new HttpError(404, 'Маршрут не найден.');
        const body = match && !match[2] && request.method === 'PATCH' ? content(input, true) : undefined;
        const row = publicMatch ? database.prepare('SELECT * FROM forms WHERE publicUrl = ?').get(`/forms/${publicMatch[1]}`) :
          database.prepare('SELECT * FROM forms WHERE id = ?').get(match?.[1]);
        if (!row) throw new HttpError(404, 'Форма не найдена.');
        const form = readForm(row);
        if (publicMatch?.[2] === 'attempts') {
          if (request.method !== 'POST') throw new HttpError(405, 'Метод не поддерживается.');
          const event = object(input);
          if (publicMatch[4]) {
            const attempt = findAttempt(form, publicMatch[3]);
            const type = /** @type {string} */ (event.type);
            const fieldEvent = ['change', 'focus', ...fieldIssues].includes(type);
            if (![...fieldIssues, ...submissionEvents, 'change', 'focus', 'activity'].includes(type) ||
                Object.keys(event).some(key => !['type', ...(fieldEvent ? ['fieldId'] : [])].includes(key)) ||
                (fieldEvent && !form.fields.some(field => field.id === event.fieldId))) {
              throw new HttpError(400, 'Передайте тип события и id поля этой формы без содержимого ответа.');
            }
            if (fieldIssues.includes(type) || submissionEvents.includes(type)) {
              database.prepare('INSERT OR IGNORE INTO attempt_signals (attemptId, type, fieldId) VALUES (?, ?, ?)')
                .run(attempt.id, type, fieldEvent ? event.fieldId : '');
            }
            if (database.prepare('SELECT id FROM responses WHERE attemptId = ?').get(attempt.id)) {
              result = attempt;
            } else {
              const now = new Date(Date.now()).toISOString();
              const startedAt = attempt.startedAt ?? (event.type === 'change' ? now : null);
              const updated = { ...attempt, startedAt, lastActiveAt: now,
                lastFieldId: startedAt && fieldEvent ? /** @type {string} */ (event.fieldId) : attempt.lastFieldId };
              database.prepare('UPDATE attempts SET startedAt = ?, lastActiveAt = ?, lastFieldId = ? WHERE id = ?')
                .run(updated.startedAt, updated.lastActiveAt, updated.lastFieldId, updated.id);
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
              database.prepare('INSERT INTO attempts (id, formId, createdAt, startedAt, lastActiveAt, lastFieldId) VALUES (?, ?, ?, ?, ?, ?)')
                .run(attempt.id, attempt.formId, attempt.createdAt, attempt.startedAt, attempt.lastActiveAt, attempt.lastFieldId);
              result = attempt;
              status = 201;
            }
          }
        } else if (publicMatch?.[2] === 'responses') {
          if (request.method !== 'POST') throw new HttpError(405, 'Метод не поддерживается.');
          if (form.status !== 'published') throw new HttpError(409, 'Приём откликов недоступен.');
          const body = object(input);
          const attempt = Object.hasOwn(body, 'attemptId') ? findAttempt(form, body.attemptId) : undefined;
          let answers;
          try { answers = validateAnswers(form, body); }
          catch (cause) {
            if (!(cause instanceof HttpError) || !attempt) throw cause;
            database.prepare("INSERT OR IGNORE INTO attempt_signals (attemptId, type) VALUES (?, 'validation_failed')").run(attempt.id);
            return { status: cause.status, result: { error: cause.message } };
          }
          const existing = attempt && database.prepare('SELECT * FROM responses WHERE attemptId = ?').get(attempt.id);
          if (existing) {
            result = readResponse(existing);
          } else {
            const accepted = { id: randomUUID(), formId: form.id, submittedAt: new Date(Date.now()).toISOString(),
              ...(attempt ? { attemptId: attempt.id } : {}), viewed: false, catalogVersion, answers };
            database.prepare('INSERT INTO responses (id, formId, attemptId, submittedAt, catalogVersion, answers) VALUES (?, ?, ?, ?, ?, ?)')
              .run(accepted.id, accepted.formId, attempt?.id ?? null, accepted.submittedAt, accepted.catalogVersion, JSON.stringify(accepted.answers));
            result = accepted;
            status = 201;
          }
        } else if (match?.[2] === 'analytics') {
          if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
          const visits = /** @type {Attempt[]} */ (database.prepare('SELECT * FROM attempts WHERE formId = ? ORDER BY rowid').all(form.id));
          const started = visits.filter(attempt => attempt.startedAt !== null);
          const submitted = database.prepare('SELECT * FROM responses WHERE formId = ? ORDER BY rowid').all(form.id).map(readResponse);
          const completed = new Set(submitted.map(response => response.attemptId));
          const pending = started.filter(attempt => !completed.has(attempt.id));
          const abandoned = pending.filter(attempt => Date.now() - Date.parse(attempt.lastActiveAt) >= 30 * 60 * 1000);
          const signals = /** @type {{type: string, fieldId: string, count: number}[]} */ (database.prepare(`
            SELECT s.type, s.fieldId, COUNT(*) AS count FROM attempt_signals s
            JOIN attempts a ON a.id = s.attemptId WHERE a.formId = ? GROUP BY s.type, s.fieldId
          `).all(form.id));
          /** @param {string} type @param {string} [fieldId] */
          const count = (type, fieldId = '') => signals.find(signal => signal.type === type && signal.fieldId === fieldId)?.count ?? 0;
          result = { formId: form.id, views: visits.length, starts: started.length,
            submissions: submitted.length,
            submissionFunnel: { clicked: count('submit'), validationFailed: count('validation_failed'), requestFailed: count('request_failed'), accepted: submitted.filter(response => response.attemptId).length },
            fieldIssues: form.fields.map(field => ({ fieldId: field.id, label: field.label,
              invalidFormat: count('invalid_format', field.id), requiredMissing: count('required_missing', field.id),
              searchEmpty: count('search_empty', field.id), catalogError: count('catalog_error', field.id) })),
            inProgress: pending.length - abandoned.length, abandoned: abandoned.length,
            lastActiveFields: abandoned.map(attempt => ({ attemptId: attempt.id, fieldId: attempt.lastFieldId,
              label: form.fields.find(field => field.id === attempt.lastFieldId)?.label, lastActiveAt: attempt.lastActiveAt })) };
        } else if (match?.[2] === 'responses') {
          if (match[3]) {
            if (request.method !== 'PATCH') throw new HttpError(405, 'Метод не поддерживается.');
            const body = object(input);
            if (typeof body.viewed !== 'boolean' || Object.keys(body).some(key => key !== 'viewed')) {
              throw new HttpError(400, 'Передайте только viewed (boolean).');
            }
            const row = database.prepare('SELECT * FROM responses WHERE id = ? AND formId = ?').get(match[3], form.id);
            if (!row) throw new HttpError(404, 'Отклик этой формы не найден.');
            database.prepare('UPDATE responses SET viewed = ? WHERE id = ? AND formId = ?').run(Number(body.viewed), match[3], form.id);
            result = { ...readResponse(row), viewed: body.viewed };
          } else {
            if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
            const items = database.prepare('SELECT * FROM responses WHERE formId = ? ORDER BY rowid').all(form.id).map(readResponse);
            result = { formId: form.id, fields: form.fields, count: items.length, responses: items };
          }
        } else if (publicMatch) {
          if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
          result = form.status === 'closed' ? { ...form, message: 'Приём завершён' } : form;
        } else if (!match?.[2] && request.method === 'GET') {
          result = form;
        } else if (body) {
          if (form.status !== 'draft') throw new HttpError(409, 'Содержание опубликованной формы нельзя изменять.');
          const updated = { ...form, ...body };
          database.prepare('UPDATE forms SET title = ?, fields = ?, status = ?, publicUrl = ? WHERE id = ?')
            .run(updated.title, JSON.stringify(updated.fields), updated.status, updated.publicUrl, updated.id);
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
          database.prepare('UPDATE forms SET title = ?, fields = ?, status = ?, publicUrl = ? WHERE id = ?')
            .run(updated.title, JSON.stringify(updated.fields), updated.status, updated.publicUrl, updated.id);
          result = updated;
        } else {
          throw new HttpError(405, 'Метод не поддерживается.');
        }
      }
      return { result, status };
    };
    const transaction = database.transaction(execute);
    const { result, status } = catalogMatch ? execute() : request.method === 'GET' ? transaction() : transaction.immediate();
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
