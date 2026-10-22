import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { start } from '../test-support/server.js';

test('поиск городов различает одноимённые города и читает выбранный ID через HTTP без внешней сети', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd, ['--import', new URL('../test-support/offline.js', import.meta.url).href]);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const result = await app.request('/api/catalogs/cities?q=%20КИРОВ%20');
  assert.equal(result.status, 200);
  assert.equal(result.body.version, '2026-10-22');
  const cities = result.body.items.filter(city => city.name === 'Киров');
  assert.deepEqual(cities.map(city => city.region).sort(), ['Калужская область', 'Кировская область']);
  assert.equal(new Set(cities.map(city => city.id)).size, 2);
  for (const city of cities) {
    assert.deepEqual(await app.request(`/api/catalogs/cities/${city.id}`), {
      status: 200, body: { version: result.body.version, item: city },
    });
  }
});

test('локальные справочники дают весь снимок, поиск по названию и чтение без предварительного поиска', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd, ['--import', new URL('../test-support/offline.js', import.meta.url).href]);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const hse = { id: 'Q1959511', name: 'Высшая школа экономики' };
  assert.deepEqual(await app.request('/api/catalogs/universities/Q1959511'), {
    status: 200, body: { version: '2026-10-22', item: hse },
  });
  const found = await app.request('/api/catalogs/universities?q=ВЫСШАЯ%20ШКОЛА%20ЭКОНОМИКИ');
  assert.equal(found.status, 200);
  assert.ok(found.body.items.some(item => item.id === hse.id && item.name === hse.name));
  const cities = await app.request('/api/catalogs/cities');
  const universities = await app.request('/api/catalogs/universities?q=');
  for (const [result, count] of [[cities, 1117], [universities, 438]]) {
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, count);
    assert.equal(new Set(result.body.items.map(item => item.id)).size, count);
    assert.ok(result.body.items.every(item => item.id && item.name));
  }
  assert.ok(cities.body.items.every(city => city.region));
  assert.ok(!universities.body.items.some(item => /колледж|техникум|факультет/iu.test(item.name)));
  for (const id of ['Q110279659', 'Q4207865', 'Q4314683', 'Q141460888', 'Q18786086']) {
    assert.ok(!universities.body.items.some(item => item.id === id));
    assert.equal((await app.request(`/api/catalogs/universities/${id}`)).status, 404);
  }
  const yo = await app.request('/api/catalogs/cities?q=ОрЁл');
  assert.equal(yo.status, 200);
  assert.ok(yo.body.items.some(city => city.name === 'Орел' && city.region === 'Орловская область'));
  for (const kind of ['cities', 'universities']) {
    assert.deepEqual(await app.request(`/api/catalogs/${kind}?q=нет-такого-названия-123456`), {
      status: 200, body: { version: '2026-10-22', items: [] },
    });
    for (const id of ['unknown', 'toString', 'Q999999999999', '00000000-0000-0000-0000-000000000000']) {
      const missing = await app.request(`/api/catalogs/${kind}/${id}`);
      assert.equal(missing.status, 404);
      assert.equal(typeof missing.body.error, 'string');
      assert.ok(!('item' in missing.body));
    }
    assert.equal((await app.request(`/api/catalogs/${kind}`, 'POST', {})).status, 405);
    assert.equal((await app.request(`/api/catalogs/${kind}/${hse.id}`, 'DELETE')).status, 405);
  }
  assert.equal((await app.request('/api/catalogs/unknown')).status, 404);
  assert.equal((await app.request('/api/catalogs/cities/Q1959511')).status, 404);
  assert.equal((await app.request('/api/catalogs/universities/452a2ddf-88a1-4e35-8d8d-8635493768d4')).status, 404);
});
