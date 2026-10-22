import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { start } from '../test-support/server.js';

test('SQLite начинает с пустой базы и не читает, не изменяет старые JSON-файлы', async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  let app;
  t.after(async () => { await app?.stop(); await rm(cwd, { recursive: true, force: true }); });
  await mkdir(resolve(cwd, 'data'));
  const legacy = {
    'forms.json': JSON.stringify([{ id: 'old', title: 'Старая форма', fields: [], status: 'draft', publicUrl: null }]),
    'responses.json': 'Повреждённый старый JSON откликов',
    'attempts.json': 'Повреждённый старый JSON попыток',
  };
  for (const [name, text] of Object.entries(legacy)) await writeFile(resolve(cwd, 'data', name), text);
  app = await start(cwd);
  assert.deepEqual(await app.request('/api/forms'), { status: 200, body: [] });
  const created = await app.request('/api/forms', 'POST', { title: 'Новая форма', fields: [] });
  assert.equal(created.status, 201);
  await app.stop();
  app = await start(cwd);
  assert.deepEqual((await app.request('/api/forms')).body, [created.body]);
  for (const [name, text] of Object.entries(legacy)) assert.equal(await readFile(resolve(cwd, 'data', name), 'utf8'), text);
});

test('повреждённая SQLite-база прерывает запуск и не заменяется пустой', async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(resolve(cwd, 'data'));
  const path = resolve(cwd, 'data/forms.sqlite');
  await writeFile(path, 'Повреждённая база');
  await assert.rejects(start(cwd), /SQLITE_NOTADB|not a database/);
  assert.equal(await readFile(path, 'utf8'), 'Повреждённая база');
});

test('ошибка после записи откатывает всю транзакцию до успешного повторения', async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  let app = await start(cwd);
  const database = new Database(resolve(cwd, 'data/forms.sqlite'));
  t.after(async () => { database.close(); await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const draft = (await app.request('/api/forms', 'POST', { title: 'Исходная форма', fields: [] })).body;
  database.exec(`CREATE TRIGGER fail_publish AFTER UPDATE ON forms WHEN NEW.status = 'published'
    BEGIN
      UPDATE forms SET title = 'Частичная запись' WHERE id = NEW.id;
      SELECT RAISE(FAIL, 'Искусственный сбой после записи');
    END`);
  const path = `/api/forms/${draft.id}`;
  assert.equal((await app.request(`${path}/publish`, 'POST')).status, 500);
  assert.deepEqual((await app.request(path)).body, draft);
  await app.stop();
  app = await start(cwd);
  assert.deepEqual((await app.request(path)).body, draft);
  database.exec('DROP TRIGGER fail_publish');
  assert.equal((await app.request(`${path}/publish`, 'POST')).body.status, 'published');
});

test('два процесса видят актуальные данные и сохраняют один отклик на попытку', async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const first = await start(cwd);
  let second;
  t.after(async () => { await first.stop(); await second?.stop(); await rm(cwd, { recursive: true, force: true }); });
  second = await start(cwd);
  const draft = (await first.request('/api/forms', 'POST', { title: 'Общая форма', fields: [] })).body;
  const path = `/api/forms/${draft.id}`;
  const published = (await second.request(`${path}/publish`, 'POST')).body;
  assert.deepEqual((await first.request(path)).body, published);
  const attempt = (await first.request(`${published.publicUrl}/attempts`, 'POST', {})).body;
  const sent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? first : second).request(`${published.publicUrl}/responses`, 'POST', { attemptId: attempt.id, answers: {} })));
  assert.equal(sent.filter(result => result.status === 201).length, 1);
  assert.ok(sent.every(result => [200, 201].includes(result.status)));
  assert.equal(new Set(sent.map(result => result.body.id)).size, 1);
  for (const app of [first, second]) {
    assert.equal((await app.request(`${path}/responses`)).body.count, 1);
    assert.equal((await app.request(`${path}/analytics`)).body.submissions, 1);
  }
});
