import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { start } from '../test-support/server.js';

async function setup(t) {
  const cwd = await mkdtemp(resolve('.test-data-'));
  let app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  return {
    cwd,
    get app() { return app; },
    async restart() { await app.stop(); app = await start(cwd); },
  };
}

async function publish(app, fields) {
  const created = await app.request('/api/forms', 'POST', { title: 'Стажировка', fields });
  assert.equal(created.status, 201);
  const result = await app.request(`/api/forms/${created.body.id}/publish`, 'POST');
  assert.equal(result.status, 200);
  return result.body;
}

test('студент отправляет все типы ответов, менеджер читает их по исходным полям после перезапуска', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const fields = ['short_text', 'long_text', 'email', 'single_choice', 'city', 'university', 'study_direction', 'study_level_course']
    .map(type => ({ id: type, type, label: type, required: true, ...(type === 'single_choice' ? { options: ['Да', 'Нет'] } : {}) }));
  const form = await publish(app, fields);
  assert.deepEqual((await app.request(form.publicUrl)).body.fields, fields);
  const city = (await app.request('/api/catalogs/cities?q=Москва')).body.items[0];
  const university = (await app.request('/api/catalogs/universities')).body.items[0];
  const direction = (await app.request('/api/catalogs/study-directions/okso-2.09.03.01')).body.item;
  const course = (await app.request('/api/catalogs/study-courses/bachelor-4plus')).body.item;
  const answers = {
    short_text: 'Анна', long_text: '<script>alert(1)</script>\nО себе', email: 'anna@example.org', single_choice: 'Да',
    city: city.id, university: university.id, study_direction: direction.id, study_level_course: course.id,
  };
  const sent = await app.request(`${form.publicUrl}/responses`, 'POST', { answers });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.id);
  assert.equal(sent.body.formId, form.id);
  assert.ok(Number.isFinite(Date.parse(sent.body.submittedAt)));
  assert.equal(sent.body.catalogVersion, '2026-10-22');
  assert.deepEqual(sent.body.answers, { ...answers, city, university, study_direction: direction, study_level_course: course });
  const expected = { formId: form.id, fields, count: 1, responses: [sent.body] };
  assert.deepEqual((await app.request(`/api/forms/${form.id}/responses`)).body, expected);
  assert.deepEqual((await app.request(form.publicUrl)).body, form);
  await fixture.restart();
  assert.deepEqual((await fixture.app.request(`/api/forms/${form.id}/responses`)).body, expected);
});

test('прямые HTTP-запросы с неверными ответами не создают откликов', async t => {
  const { app } = await setup(t);
  const fields = ['short_text', 'long_text', 'email', 'single_choice', 'city', 'university', 'study_direction', 'study_level_course']
    .map(type => ({ id: type, type, label: type, required: true, ...(type === 'single_choice' ? { options: ['Да'] } : {}) }));
  const form = await publish(app, fields);
  const city = (await app.request('/api/catalogs/cities')).body.items[0].id;
  const university = (await app.request('/api/catalogs/universities')).body.items[0].id;
  const valid = { short_text: 'Имя', long_text: 'Текст', email: 'a@example.org', single_choice: 'Да', city, university,
    study_direction: 'okso-2.09.03.01', study_level_course: 'bachelor-1' };
  const invalid = [null, [], {}, { answers: null }, { answers: [] }, { answers: valid, extra: true },
    { answers: { ...valid, unknown: 'Ответ' } }];
  for (const field of fields) {
    const missing = { ...valid };
    delete missing[field.id];
    invalid.push({ answers: missing });
    for (const value of [null, '', '  ', 42, true, [], {}, { id: valid[field.id] }]) {
      invalid.push({ answers: { ...valid, [field.id]: value } });
    }
  }
  for (const [id, values] of [
    ['email', ['a', 'a@b', 'a@@b.org', 'a b@example.org', 'a@example.org\n']],
    ['single_choice', ['Нет', 'Да ']], ['city', ['Москва', 'unknown', university, 'toString']],
    ['university', ['Вуз', 'unknown', city]], ['study_direction', ['09.03.01', 'unknown', 'bachelor-1']],
    ['study_level_course', ['4+', 'unknown', 'bachelor-5', 'okso-2.09.03.01', 'master-1']],
  ]) {
    for (const value of values) invalid.push({ answers: { ...valid, [id]: value } });
  }
  for (const body of invalid) {
    const response = await app.request(`${form.publicUrl}/responses`, 'POST', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok(response.body.error);
  }
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 0);
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers: valid })).status, 201);
});

test('необязательные поля пропускаются, курс работает без направления, все групповые курсы допустимы', async t => {
  const { app } = await setup(t);
  const form = await publish(app, [
    { id: 'direction', type: 'study_direction', label: 'Направление', required: false },
    { id: 'course', type: 'study_level_course', label: 'Курс', required: false },
    { id: 'city', type: 'city', label: 'Город', required: false },
    { id: 'university', type: 'university', label: 'Вуз', required: false },
  ]);
  for (const answers of [{}, { course: 'master-2plus' }, { direction: 'okso-2.09.03.01' },
    { direction: 'okso-2.09.03.01', course: 'bachelor-4plus' },
    { direction: 'okso-2.09.04.01', course: 'master-2plus' },
    { direction: 'okso-3.31.05.01', course: 'specialist-5plus' }]) {
    assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers })).status, 201);
  }
  for (const answers of [{ city: 'unknown' }, { course: 'Свободный текст' },
    { direction: 'okso-2.09.04.01', course: 'bachelor-4plus' }]) {
    assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers })).status, 400);
  }
  const courseOnly = await publish(app, [{ id: 'course', type: 'study_level_course', label: 'Курс', required: true }]);
  assert.equal((await app.request(`${courseOnly.publicUrl}/responses`, 'POST', { answers: { course: 'master-2plus' } })).status, 201);
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 6);
});

test('черновик недоступен студенту, закрытие запрещает отправку, повторное открытие сохраняет отдельные отклики', async t => {
  const { app } = await setup(t);
  const draft = (await app.request('/api/forms', 'POST', { title: 'Форма', fields: [] })).body;
  const path = `/api/forms/${draft.id}`;
  assert.equal((await app.request(`/forms/${draft.id}/responses`, 'POST', { answers: {} })).status, 404);
  assert.equal((await app.request(`${path}/responses`, 'POST', { answers: {} })).status, 405);
  assert.equal((await app.request(`${path}/responses`)).body.count, 0);
  const form = (await app.request(`${path}/publish`, 'POST')).body;
  const endpoint = `${form.publicUrl}/responses`;
  const first = await app.request(endpoint, 'POST', { answers: {} });
  assert.equal(first.status, 201);
  await app.request(`${path}/close`, 'POST');
  assert.equal((await app.request(endpoint, 'POST', { answers: {} })).status, 409);
  assert.deepEqual((await app.request(`${path}/responses`)).body.responses, [first.body]);
  await app.request(`${path}/reopen`, 'POST');
  const second = await app.request(endpoint, 'POST', { answers: {} });
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
  assert.deepEqual((await app.request(`${path}/responses`)).body.responses, [first.body, second.body]);
  assert.equal((await app.request(endpoint)).status, 405);
  assert.equal((await app.request('/forms/unknown/responses', 'POST', { answers: {} })).status, 404);
  assert.equal((await app.request('/api/forms/unknown/responses')).status, 404);
});

test('состояние приёма проверяется после полного получения тела запроса', async t => {
  const { app } = await setup(t);
  const form = await publish(app, []);
  const completed = new Promise((resolve, reject) => {
    const request = httpRequest(new URL(`${form.publicUrl}/responses`, app.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write('{"answers":');
    app.request(`/api/forms/${form.id}/close`, 'POST').then(() => request.end('{} }'), reject);
  });
  assert.equal(await completed, 409);
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 0);
});

test('параллельные повторные отправки разных форм не теряются после перезапуска', async t => {
  const fixture = await setup(t);
  const forms = await Promise.all([publish(fixture.app, []), publish(fixture.app, [])]);
  const sent = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    fixture.app.request(`${forms[i % 2].publicUrl}/responses`, 'POST', { answers: {} })));
  assert.ok(sent.every(response => response.status === 201));
  assert.equal(new Set(sent.map(response => response.body.id)).size, 40);
  await fixture.restart();
  for (const form of forms) {
    const listed = await fixture.app.request(`/api/forms/${form.id}/responses`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.count, 20);
    assert.deepEqual(new Set(listed.body.responses.map(response => response.id)),
      new Set(sent.filter(response => response.body.formId === form.id).map(response => response.body.id)));
  }
});

test('отказ записи не подтверждает и не добавляет отклик, сохранённые данные остаются доступны', async t => {
  const fixture = await setup(t);
  const form = await publish(fixture.app, []);
  const first = await fixture.app.request(`${form.publicUrl}/responses`, 'POST', { answers: {} });
  assert.equal(first.status, 201);
  const data = resolve(fixture.cwd, 'data');
  const backup = resolve(fixture.cwd, 'data-backup');
  await rename(data, backup);
  await writeFile(data, 'Хранилище временно недоступно');
  const failed = await fixture.app.request(`${form.publicUrl}/responses`, 'POST', { answers: {} });
  assert.equal(failed.status, 500);
  assert.ok(failed.body.error);
  assert.deepEqual((await fixture.app.request(`/api/forms/${form.id}/responses`)).body.responses, [first.body]);
  await rm(data);
  await rename(backup, data);
  await fixture.restart();
  assert.deepEqual((await fixture.app.request(`/api/forms/${form.id}/responses`)).body.responses, [first.body]);
  assert.equal((await fixture.app.request(`${form.publicUrl}/responses`, 'POST', { answers: {} })).status, 201);
});

test('обновление справочников не меняет принятые значения и исходные вопросы', async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const release = resolve(cwd, 'release');
  await cp(resolve('src'), resolve(release, 'src'), { recursive: true });
  await cp(resolve('catalogs/snapshots'), resolve(release, 'catalogs/snapshots'), { recursive: true });
  const entrypoint = resolve(release, 'src/server.js');
  let app = await start(cwd, [], entrypoint);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const form = await publish(app, ['city', 'university', 'study_direction', 'study_level_course']
    .map(type => ({ id: type, type, label: `Исходное поле ${type}`, required: true })));
  const city = (await app.request('/api/catalogs/cities')).body.items[0].id;
  const university = (await app.request('/api/catalogs/universities')).body.items[0].id;
  const answers = { city, university, study_direction: 'okso-2.09.03.01', study_level_course: 'bachelor-1' };
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers })).status, 201);
  const before = await app.request(`/api/forms/${form.id}/responses`);
  await app.stop();
  for (const [file, removals] of [
    ['2026-10-22.json', { cities: city, universities: university }],
    ['2026-10-22-study.json', { 'study-directions': answers.study_direction, 'study-courses': answers.study_level_course }],
  ]) {
    const path = resolve(release, 'catalogs/snapshots', file);
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    for (const [kind, id] of Object.entries(removals)) catalog[kind] = catalog[kind].filter(item => item.id !== id);
    await writeFile(path, JSON.stringify(catalog));
  }
  app = await start(cwd, [], entrypoint);
  assert.deepEqual(await app.request(`/api/forms/${form.id}/responses`), before);
  assert.deepEqual((await app.request(form.publicUrl)).body.fields, form.fields);
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers })).status, 400);
  assert.deepEqual(await app.request(`/api/forms/${form.id}/responses`), before);
});

test('идентификаторы полей не пересекаются со свойствами прототипа объекта', async t => {
  const { app } = await setup(t);
  const form = await publish(app, ['__proto__', 'constructor', 'toString']
    .map(id => ({ id, type: 'short_text', label: id, required: true })));
  const answers = JSON.parse('{"__proto__":"Текст","constructor":"Имя","toString":"Ответ"}');
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers: {} })).status, 400);
  const response = await app.request(`${form.publicUrl}/responses`, 'POST', { answers });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.answers, answers);
  assert.deepEqual((await app.request(`/api/forms/${form.id}/responses`)).body.responses, [response.body]);
  const optionalDirection = await publish(app, [
    { id: '__proto__', type: 'study_direction', label: 'Направление', required: false },
    { id: 'course', type: 'study_level_course', label: 'Курс', required: true },
  ]);
  assert.equal((await app.request(`${optionalDirection.publicUrl}/responses`, 'POST', {
    answers: { course: 'master-1' },
  })).status, 201);
});

test('отправка соблюдает JSON-контракт и предел размера тела без создания отклика', async t => {
  const { app } = await setup(t);
  const form = await publish(app, []);
  const url = new URL(`${form.publicUrl}/responses`, app.url);
  for (const [headers, body, expected] of [
    [{}, '{}', 415],
    [{ 'Content-Type': 'application/json' }, '{', 400],
    [{ 'Content-Type': 'application/json' }, JSON.stringify({ answers: { text: 'a'.repeat(1024 * 1024) } }), 413],
  ]) {
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, expected);
    assert.ok((await response.json()).error);
  }
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 0);
});
