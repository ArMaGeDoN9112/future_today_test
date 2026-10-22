import { blockWrites } from '../test-support/storage.js';
import { start } from '../test-support/server.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('менеджер создаёт и изменяет черновик через HTTP', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  assert.deepEqual(await app.request('/api/forms'), { status: 200, body: [] });
  const created = await app.request('/api/forms', 'POST', { title: 'Стажировка', fields: [] });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'draft');
  assert.ok(created.body.id);
  const path = `/api/forms/${created.body.id}`;
  assert.deepEqual((await app.request(path)).body, created.body);
  const fields = [{ id: 'name', type: 'short_text', label: 'Имя', required: true }];
  const updated = await app.request(path, 'PATCH', { title: 'Набор', fields });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, 'Набор');
  assert.deepEqual(updated.body.fields, fields);
  assert.deepEqual((await app.request('/api/forms')).body, [updated.body]);
});

test('все типы полей сохраняют id при изменении и удалении полей черновика', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const fields = ['short_text', 'long_text', 'email', 'single_choice', 'city', 'university', 'study_direction', 'study_level_course']
    .map(type => ({ id: type, type, label: type, required: false, ...(type === 'single_choice' ? { options: ['Да', 'Нет'] } : {}) }));
  const created = await app.request('/api/forms', 'POST', { title: 'Все поля', fields });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.fields, fields);
  const edited = fields.slice(1).map(field => field.id === 'email' ? { ...field, label: 'Почта', required: true } : field);
  edited.push({ id: 'extra', type: 'short_text', label: 'Дополнение', required: false });
  const path = `/api/forms/${created.body.id}`;
  assert.equal((await app.request(path, 'PATCH', { fields: edited })).status, 200);
  assert.deepEqual((await app.request(path)).body.fields, edited);
});

test('некорректная структура и подмена состояния отклоняются без изменения черновика', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const field = { id: 'name', type: 'short_text', label: 'Имя', required: true };
  const draft = (await app.request('/api/forms', 'POST', { title: 'Форма', fields: [field] })).body;
  const path = `/api/forms/${draft.id}`;
  const invalid = [null, [], {}, { title: '' }, { title: 42 }, { fields: {} }, { status: 'published' },
    { publicUrl: '/forms/fake' }, { fields: [field, field] }, { fields: [{ ...field, id: '' }] },
    { fields: [{ ...field, label: ' ' }] }, { fields: [{ ...field, required: 'true' }] },
    { fields: [{ ...field, type: 'unknown' }] }, { fields: [{ ...field, options: ['Лишнее'] }] },
    ...[undefined, [], [''], ['Да', ' Да '], [42]].map(options => ({ fields: [{ ...field, type: 'single_choice', options }] })),
  ];
  for (const body of invalid) {
    const result = await app.request(path, 'PATCH', body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(typeof result.body.error, 'string');
  }
  for (const body of [{ title: 'Форма' }, { fields: [] }, { title: ' ', fields: [] }]) {
    assert.equal((await app.request('/api/forms', 'POST', body)).status, 400);
  }
  assert.deepEqual((await app.request(path)).body, draft);
  assert.deepEqual((await app.request('/api/forms')).body, [draft]);
  const malformed = await fetch(new URL(path, app.url), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(new URL(path, app.url), { method: 'PATCH', body: '{}' });
  assert.equal(wrongType.status, 415);
  const tooLarge = await fetch(new URL(path, app.url), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'a'.repeat(1024 * 1024) }) });
  assert.equal(tooLarge.status, 413);
});

test('запрос изменения, начатый до публикации, не меняет опубликованное содержание', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const draft = (await app.request('/api/forms', 'POST', { title: 'Исходное', fields: [] })).body;
  const path = `/api/forms/${draft.id}`;
  const pending = httpRequest(new URL(path, app.url), { method: 'PATCH', headers: { 'Content-Type': 'application/json' } });
  t.after(() => pending.destroy());
  const response = new Promise((resolve, reject) => {
    pending.on('error', reject);
    pending.on('response', response => { response.resume(); resolve(response.statusCode); });
  });
  pending.write('{"title":');
  assert.equal((await app.request(`${path}/publish`, 'POST')).status, 200);
  pending.end('"Подмена"}');
  assert.equal(await response, 409);
  assert.equal((await app.request(path)).body.title, 'Исходное');
});

test('ошибка записи не выдаётся за успех и не изменяет ранее сохранённые формы', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  let app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const draft = (await app.request('/api/forms', 'POST', { title: 'Сохранено', fields: [] })).body;
  const path = `/api/forms/${draft.id}`;
  const release = blockWrites(t, cwd);
  assert.equal((await app.request(path, 'PATCH', { title: 'Не сохранено' })).status, 500);
  assert.equal((await app.request(`${path}/publish`, 'POST')).status, 500);
  assert.equal((await app.request('/api/forms', 'POST', { title: 'Не создано', fields: [] })).status, 500);
  assert.deepEqual((await app.request(path)).body, draft);
  assert.deepEqual((await app.request('/api/forms')).body, [draft]);
  release();
  await app.stop();
  app = await start(cwd);
  assert.deepEqual((await app.request('/api/forms')).body, [draft]);
  assert.equal((await app.request(`${path}/publish`, 'POST')).body.status, 'published');
});

test('публикация фиксирует содержание, закрытие и открытие сохраняют ссылку', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const fields = [{ id: 'email', type: 'email', label: 'Email', required: true }];
  const { body: draft } = await app.request('/api/forms', 'POST', { title: 'Практика', fields });
  const path = `/api/forms/${draft.id}`;
  assert.equal((await app.request(`/forms/${draft.id}`)).status, 404);
  assert.equal((await app.request(`${path}/close`, 'POST')).status, 409);
  assert.equal((await app.request(`${path}/reopen`, 'POST')).status, 409);
  const published = await app.request(`${path}/publish`, 'POST');
  assert.equal(published.status, 200);
  assert.equal(published.body.status, 'published');
  assert.ok(published.body.publicUrl);
  assert.deepEqual((await app.request(published.body.publicUrl)).body, published.body);
  assert.equal((await app.request(`${path}/publish`, 'POST')).status, 409);
  for (const state of ['published', 'closed', 'published']) {
    assert.equal((await app.request(path)).body.status, state);
    assert.equal((await app.request(path, 'PATCH', { title: 'Подмена', fields: [] })).status, 409);
    const visible = await app.request(published.body.publicUrl);
    assert.equal(visible.status, 200);
    assert.equal(visible.body.status, state);
    assert.equal(visible.body.title, 'Практика');
    assert.deepEqual(visible.body.fields, fields);
    assert.equal(visible.body.publicUrl, published.body.publicUrl);
    if (state === 'closed') assert.equal(visible.body.message, 'Приём завершён');
    if (state === 'closed') await app.request(`${path}/reopen`, 'POST');
    else await app.request(`${path}/close`, 'POST');
  }
  const { body: second } = await app.request('/api/forms', 'POST', { title: 'Другая', fields: [] });
  const other = await app.request(`/api/forms/${second.id}/publish`, 'POST');
  assert.notEqual(other.body.publicUrl, published.body.publicUrl);
  assert.equal((await app.request('/forms/unknown')).status, 404);
});

test('черновик, опубликованная и закрытая формы переживают перезапуск без потерь при конкуренции', { timeout: 15000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  let app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const created = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    app.request('/api/forms', 'POST', { title: `Форма ${i}`, fields: [] })));
  assert.ok(created.every(response => response.status === 201));
  assert.equal(new Set(created.map(response => response.body.id)).size, 20);
  const path = `/api/forms/${created[0].body.id}`;
  const updates = await Promise.all([
    app.request(path, 'PATCH', { title: 'Исправлено' }),
    app.request(path, 'PATCH', { fields: [{ id: 'city', type: 'city', label: 'Город', required: false }] }),
  ]);
  assert.ok(updates.every(response => response.status === 200));
  assert.equal((await app.request(path)).body.title, 'Исправлено');
  assert.equal((await app.request(path)).body.fields.length, 1);
  const publishedPath = `/api/forms/${created[1].body.id}`;
  const published = await app.request(`${publishedPath}/publish`, 'POST');
  const closedPath = `/api/forms/${created[2].body.id}`;
  const closed = await app.request(`${closedPath}/publish`, 'POST');
  await app.request(`${closedPath}/close`, 'POST');
  const before = await app.request('/api/forms');
  await app.stop();
  app = await start(cwd);
  assert.deepEqual(await app.request('/api/forms'), before);
  assert.equal((await app.request(published.body.publicUrl)).body.status, 'published');
  assert.equal((await app.request(closed.body.publicUrl)).body.message, 'Приём завершён');
  assert.equal((await app.request(`${closedPath}/reopen`, 'POST')).body.publicUrl, closed.body.publicUrl);
  assert.equal((await app.request(closedPath, 'PATCH', { fields: [] })).status, 409);
});
