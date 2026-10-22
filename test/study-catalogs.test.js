import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { start } from '../test-support/server.js';

test('направления доступны без сети: поиск по коду и названию, уровень и устойчивый ID', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd, ['--import', new URL('../test-support/offline.js', import.meta.url).href]);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const found = await app.request('/api/catalogs/study-directions?q=09.03.01');
  assert.equal(found.status, 200);
  const bachelor = {
    id: 'okso-2.09.03.01', code: '09.03.01', name: 'Информатика и вычислительная техника', level: 'bachelor',
  };
  assert.deepEqual(found.body.items, [bachelor]);
  const byName = await app.request(`/api/catalogs/study-directions?${new URLSearchParams({ q: '  ИНФОРМАТИКА И ВЫЧИСЛИТЕЛЬНАЯ ТЕХНИКА ' })}`);
  assert.deepEqual(byName.body.items, [bachelor, {
    id: 'okso-2.09.04.01', code: '09.04.01', name: bachelor.name, level: 'master',
  }]);
  assert.deepEqual((await app.request(`/api/catalogs/study-directions/${bachelor.id}`)).body.item, bachelor);
  assert.deepEqual((await app.request('/api/catalogs/study-directions/okso-3.31.05.01')).body.item, {
    id: 'okso-3.31.05.01', code: '31.05.01', name: 'Лечебное дело', level: 'specialist',
  });
  const all = await app.request('/api/catalogs/study-directions');
  assert.equal(all.body.items.length, 490);
  assert.equal(new Set(all.body.items.map(item => item.id)).size, 490);
  for (const [level, middle, count] of [['bachelor', '03', 181], ['master', '04', 195], ['specialist', '05', 114]]) {
    const entries = all.body.items.filter(item => item.level === level);
    assert.equal(entries.length, count);
    assert.ok(entries.every(item => new RegExp(`^\\d{2}\\.${middle}\\.\\d{2}$`).test(item.code) && item.name));
  }
  assert.deepEqual((await app.request('/api/catalogs/study-directions?q=нет-такого-направления')).body.items, []);
  for (const id of ['unknown', 'toString', 'okso-2.09.02.01']) {
    assert.equal((await app.request(`/api/catalogs/study-directions/${id}`)).status, 404);
  }
  assert.equal((await app.request('/api/catalogs/study-directions', 'POST', {})).status, 405);
});

test('11 вариантов курса доступны самостоятельно и фильтруются по направлению', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd, ['--import', new URL('../test-support/offline.js', import.meta.url).href]);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const expected = [
    ['bachelor-1', 'Бакалавриат — 1 курс', 'bachelor', '1'],
    ['bachelor-2', 'Бакалавриат — 2 курс', 'bachelor', '2'],
    ['bachelor-3', 'Бакалавриат — 3 курс', 'bachelor', '3'],
    ['bachelor-4plus', 'Бакалавриат — 4 курс и выше (4+)', 'bachelor', '4+'],
    ['master-1', 'Магистратура — 1 курс', 'master', '1'],
    ['master-2plus', 'Магистратура — 2 курс и выше (2+)', 'master', '2+'],
    ['specialist-1', 'Специалитет — 1 курс', 'specialist', '1'],
    ['specialist-2', 'Специалитет — 2 курс', 'specialist', '2'],
    ['specialist-3', 'Специалитет — 3 курс', 'specialist', '3'],
    ['specialist-4', 'Специалитет — 4 курс', 'specialist', '4'],
    ['specialist-5plus', 'Специалитет — 5 курс и выше (5+)', 'specialist', '5+'],
  ].map(([id, name, level, course]) => ({ id, name, level, course }));
  const all = await app.request('/api/catalogs/study-courses');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items, expected);
  for (const item of expected) {
    assert.deepEqual((await app.request(`/api/catalogs/study-courses/${item.id}`)).body.item, item);
  }
  for (const [direction, level] of [['okso-2.09.03.01', 'bachelor'], ['okso-2.09.04.01', 'master'], ['okso-3.31.05.01', 'specialist']]) {
    const result = await app.request(`/api/catalogs/study-courses?directionId=${direction}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, expected.filter(item => item.level === level));
  }
  for (const id of ['unknown', 'toString', 'bachelor-5', 'master-3', 'specialist-6']) {
    const missing = await app.request(`/api/catalogs/study-courses/${id}`);
    assert.equal(missing.status, 404);
    assert.equal(typeof missing.body.error, 'string');
    assert.ok(!('item' in missing.body));
    assert.equal((await app.request(`/api/catalogs/study-courses?directionId=${id}`)).status, 404);
  }
  assert.equal((await app.request('/api/catalogs/study-courses?directionId=')).status, 404);
  assert.equal((await app.request('/api/catalogs/study-courses', 'POST', {})).status, 405);
});
