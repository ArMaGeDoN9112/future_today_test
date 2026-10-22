import { blockWrites } from '../test-support/storage.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { start } from '../test-support/server.js';

async function setup(t) {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const clock = resolve(cwd, 'clock');
  await writeFile(clock, String(Date.parse('2026-10-22T10:00:00Z')));
  const args = ['--import', new URL('../test-support/clock.js', import.meta.url).href];
  let app = await start(cwd, args);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  return {
    cwd,
    get app() { return app; },
    async time(value) { await writeFile(clock, String(Date.parse(value))); },
    async restart() { await app.stop(); app = await start(cwd, args); },
  };
}

async function publish(app) {
  const created = await app.request('/api/forms', 'POST', { title: 'Стажировка', fields: [
    { id: 'name', type: 'short_text', label: 'Имя', required: true },
    { id: 'email', type: 'email', label: 'Почта', required: false },
  ] });
  assert.equal(created.status, 201);
  return (await app.request(`/api/forms/${created.body.id}/publish`, 'POST')).body;
}

async function attempt(app, form) {
  const result = await app.request(`${form.publicUrl}/attempts`, 'POST', {});
  assert.equal(result.status, 201);
  assert.ok(result.body.id);
  return result.body;
}

async function analytics(app, form) {
  const result = await app.request(`/api/forms/${form.id}/analytics`);
  assert.equal(result.status, 200);
  return result.body;
}

function event(app, form, attempt, body) {
  return app.request(`${form.publicUrl}/attempts/${attempt.id}/events`, 'POST', body);
}

test('просмотр и фокус не начинают заполнение; обновление продолжает попытку, другая вкладка создаёт отдельную', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const form = await publish(app);
  await app.request(form.publicUrl);
  const first = await attempt(app, form);
  assert.equal((await event(app, form, first, { type: 'focus', fieldId: 'name' })).status, 200);
  const resumed = await app.request(`${form.publicUrl}/attempts`, 'POST', { attemptId: first.id });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.id, first.id);
  const second = await attempt(app, form);
  assert.notEqual(second.id, first.id);
  await fixture.time('2026-10-22T12:00:00Z');
  const expected = { formId: form.id, views: 2, starts: 0, submissions: 0, inProgress: 0, abandoned: 0, lastActiveFields: [] };
  assert.deepEqual(await analytics(app, form), expected);
  await fixture.restart();
  assert.deepEqual(await analytics(fixture.app, form), expected);
});

test('изменение начинает попытку один раз; граница 30 минут, место остановки и возврат учитывают активность', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const form = await publish(app);
  const first = await attempt(app, form);
  const second = await attempt(app, form);
  const change = { type: 'change', fieldId: 'name' };
  const started = await event(app, form, first, change);
  assert.equal(started.status, 200);
  assert.equal(started.body.startedAt, '2026-10-22T10:00:00.000Z');
  assert.equal((await event(app, form, first, change)).status, 200);
  await fixture.time('2026-10-22T10:29:59.999Z');
  assert.deepEqual(await analytics(app, form), { formId: form.id, views: 2, starts: 1, submissions: 0,
    inProgress: 1, abandoned: 0, lastActiveFields: [] });
  await fixture.time('2026-10-22T10:30:00Z');
  assert.deepEqual(await analytics(app, form), { formId: form.id, views: 2, starts: 1, submissions: 0,
    inProgress: 0, abandoned: 1, lastActiveFields: [
      { attemptId: first.id, fieldId: 'name', label: 'Имя', lastActiveAt: '2026-10-22T10:00:00.000Z' },
    ] });
  await fixture.restart();
  const resumed = await fixture.app.request(`${form.publicUrl}/attempts`, 'POST', { attemptId: first.id });
  assert.equal(resumed.body.startedAt, started.body.startedAt);
  assert.equal((await analytics(fixture.app, form)).abandoned, 1);
  assert.equal((await event(fixture.app, form, first, { type: 'focus', fieldId: 'email' })).status, 200);
  assert.equal((await analytics(fixture.app, form)).inProgress, 1);
  await fixture.time('2026-10-22T10:59:00Z');
  assert.equal((await event(fixture.app, form, first, { type: 'activity' })).status, 200);
  assert.equal((await event(fixture.app, form, second, change)).status, 200);
  await fixture.time('2026-10-22T11:29:00Z');
  const stopped = await analytics(fixture.app, form);
  assert.equal(stopped.starts, 2);
  assert.equal(stopped.abandoned, 2);
  assert.deepEqual(stopped.lastActiveFields.map(item => [item.attemptId, item.fieldId]), [[first.id, 'email'], [second.id, 'name']]);
});

test('ошибка отправки не завершает попытку; поздняя и повторная отправки сохраняют один отклик и корректируют аналитику', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const form = await publish(app);
  const first = await attempt(app, form);
  await event(app, form, first, { type: 'change', fieldId: 'name' });
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: first.id, answers: {} })).status, 400);
  assert.equal((await analytics(app, form)).inProgress, 1);
  await fixture.time('2026-10-22T11:00:00Z');
  assert.equal((await analytics(app, form)).abandoned, 1);
  const body = { attemptId: first.id, answers: { name: 'Анна' } };
  const sent = await app.request(`${form.publicUrl}/responses`, 'POST', body);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.attemptId, first.id);
  const retries = await Promise.all(Array.from({ length: 5 }, () => app.request(`${form.publicUrl}/responses`, 'POST', body)));
  for (const retry of retries) {
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, sent.body);
  }
  assert.deepEqual(await analytics(app, form), { formId: form.id, views: 1, starts: 1, submissions: 1,
    inProgress: 0, abandoned: 0, lastActiveFields: [] });
  await fixture.time('2026-10-23T11:00:00Z');
  assert.equal((await event(app, form, first, { type: 'change', fieldId: 'email' })).status, 200);
  await fixture.restart();
  assert.deepEqual((await fixture.app.request(`/api/forms/${form.id}/responses`)).body.responses, [sent.body]);
  assert.deepEqual(await analytics(fixture.app, form), { formId: form.id, views: 1, starts: 1, submissions: 1,
    inProgress: 0, abandoned: 0, lastActiveFields: [] });
  assert.deepEqual((await fixture.app.request(`${form.publicUrl}/responses`, 'POST', body)).body, sent.body);
  const second = await attempt(fixture.app, form);
  await event(fixture.app, form, second, { type: 'change', fieldId: 'name' });
  assert.equal((await fixture.app.request(`${form.publicUrl}/responses`, 'POST', { ...body, attemptId: second.id })).status, 201);
  assert.equal((await analytics(fixture.app, form)).submissions, 2);
});

test('чужие попытки, поля, содержимое ответов и поддельные завершения отклоняются без изменения аналитики', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const form = await publish(app);
  const other = await publish(app);
  const first = await attempt(app, form);
  const foreign = await attempt(app, other);
  const before = await analytics(app, form);
  for (const body of [null, [], { value: 'секрет' }, { attemptId: null }, { attemptId: '' }]) {
    assert.equal((await app.request(`${form.publicUrl}/attempts`, 'POST', body)).status, 400);
  }
  assert.equal((await app.request(`${form.publicUrl}/attempts`, 'POST', { attemptId: foreign.id })).status, 404);
  for (const body of [null, [], {}, { type: 'complete' }, { type: 'change' }, { type: 'change', fieldId: 'unknown' },
    { type: 'change', fieldId: 'name', value: 'секрет' }, { type: 'change', fieldId: 'name', answers: { name: 'секрет' } },
    { type: 'change', fieldId: 'name', formId: other.id }, { type: 'activity', fieldId: 'name' },
    { type: 'focus', fieldId: 42 }, { type: 'activity', startedAt: '2026-10-22' }]) {
    assert.equal((await event(app, form, first, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await event(app, form, foreign, { type: 'change', fieldId: 'name' })).status, 404);
  for (const attemptId of [foreign.id, 'unknown']) {
    assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId, answers: { name: 'Анна' } })).status, 404);
  }
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: null, answers: { name: 'Анна' } })).status, 400);
  assert.deepEqual(await analytics(app, form), before);
  assert.equal((await event(app, other, foreign, { type: 'change', fieldId: 'email' })).status, 200);
  assert.deepEqual(await analytics(app, form), before);
  assert.equal((await analytics(app, other)).starts, 1);
  await fixture.restart();
  assert.deepEqual(await analytics(fixture.app, form), before);
  assert.deepEqual((await fixture.app.request(`${form.publicUrl}/attempts`, 'POST', { attemptId: first.id })).body, first);
});

test('закрытие запрещает новые попытки и отправку; после открытия попытка продолжается и старые отклики учтены', async t => {
  const { app } = await setup(t);
  const form = await publish(app);
  const first = await attempt(app, form);
  await event(app, form, first, { type: 'change', fieldId: 'name' });
  const path = `/api/forms/${form.id}`;
  await app.request(`${path}/close`, 'POST');
  assert.equal((await app.request(`${form.publicUrl}/attempts`, 'POST', {})).status, 409);
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: first.id, answers: { name: 'Анна' } })).status, 409);
  assert.equal((await analytics(app, form)).inProgress, 1);
  await app.request(`${path}/reopen`, 'POST');
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: first.id, answers: { name: 'Анна' } })).status, 201);
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { answers: { name: 'Без попытки' } })).status, 201);
  assert.deepEqual(await analytics(app, form), { formId: form.id, views: 1, starts: 1, submissions: 2,
    inProgress: 0, abandoned: 0, lastActiveFields: [] });
  const draft = (await app.request('/api/forms', 'POST', { title: 'Черновик', fields: [] })).body;
  assert.equal((await app.request(`/forms/${draft.id}/attempts`, 'POST', {})).status, 404);
  assert.equal((await app.request('/api/forms/unknown/analytics')).status, 404);
  assert.equal((await app.request(`${path}/analytics`, 'POST', {})).status, 405);
  assert.equal((await app.request(`${form.publicUrl}/attempts`)).status, 405);
});

test('отказ записи не добавляет просмотр, начало или завершение; повтор после восстановления сохраняет данные', async t => {
  const fixture = await setup(t);
  const { app } = fixture;
  const form = await publish(app);
  const first = await attempt(app, form);
  const before = await analytics(app, form);
  const release = blockWrites(t, fixture.cwd);
  assert.equal((await app.request(`${form.publicUrl}/attempts`, 'POST', {})).status, 500);
  assert.equal((await event(app, form, first, { type: 'change', fieldId: 'name' })).status, 500);
  assert.equal((await app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: first.id, answers: { name: 'Анна' } })).status, 500);
  assert.deepEqual(await analytics(app, form), before);
  release();
  await fixture.restart();
  assert.deepEqual(await analytics(fixture.app, form), before);
  assert.equal((await event(fixture.app, form, first, { type: 'change', fieldId: 'name' })).status, 200);
  assert.equal((await fixture.app.request(`${form.publicUrl}/responses`, 'POST', { attemptId: first.id, answers: { name: 'Анна' } })).status, 201);
  assert.equal((await analytics(fixture.app, form)).submissions, 1);
});
