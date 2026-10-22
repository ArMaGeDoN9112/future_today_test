import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { start } from '../test-support/server.js';

test('менеджер и студент проходят полный цикл; закрытие, перезапуск и открытие сохраняют данные', { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const offline = ['--import', pathToFileURL(resolve('test-support/offline.js')).href];
  let app = await start(cwd, offline);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 740 } });
  const external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === 'localhost') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const manager = await context.newPage();
  const student = await context.newPage();
  manager.setDefaultTimeout(5000);
  student.setDefaultTimeout(5000);
  const unsafe = '<img src=x onerror="window.executed=true">';
  await manager.goto(`${app.url}/admin`);
  await manager.getByRole('button', { name: 'Создать форму', exact: true }).click();
  await manager.getByLabel('Название формы', { exact: true }).fill('Сквозная проверка');
  for (const [type, label] of [['short_text', unsafe], ['city', 'Город'], ['university', 'Вуз'], ['study_direction', 'Направление'], ['study_level_course', 'Курс']]) {
    await manager.getByRole('button', { name: 'Добавить поле', exact: true }).click();
    await manager.getByLabel('Тип поля', { exact: true }).last().selectOption(type);
    await manager.getByLabel('Подпись поля', { exact: true }).last().fill(label);
    await manager.getByLabel('Обязательное поле', { exact: true }).last().check();
  }
  await manager.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await manager.getByRole('status').filter({ hasText: 'Черновик сохранён' }).waitFor();
  manager.once('dialog', dialog => dialog.accept());
  await manager.getByRole('button', { name: 'Опубликовать форму', exact: true }).click();
  await manager.getByRole('heading', { name: 'Отклики (0)', exact: true }).waitFor();
  const form = (await app.request('/api/forms')).body[0];
  const path = `/api/forms/${form.id}`;
  assert.equal(await manager.getByRole('link', { name: `${app.url}${form.publicUrl}`, exact: true }).getAttribute('href'), `${app.url}${form.publicUrl}`);
  const fillAndSubmit = async () => {
    await student.getByLabel(`${unsafe} ·`, { exact: false }).fill(unsafe);
    for (const [label, query] of [['Город', 'Москва'], ['Вуз', 'Московский'], ['Направление', '09.03.01']]) {
      await student.getByLabel(`${label} ·`, { exact: false }).fill(query);
      const options = student.getByRole('listbox', { name: `Варианты: ${label}`, exact: true });
      await options.locator('option[value]:not([value=""])').first().waitFor();
      await options.focus();
      await student.keyboard.press('Home');
      await student.keyboard.press('ArrowDown');
      assert.notEqual(await options.inputValue(), '', label);
    }
    const course = student.getByLabel('Курс ·', { exact: false });
    await course.getByRole('option', { name: 'Бакалавриат — 4 курс и выше (4+)', exact: true }).waitFor({ state: 'attached' });
    await course.selectOption('bachelor-4plus');
    assert.equal(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await student.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
    await student.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  };
  await student.goto(`${app.url}${form.publicUrl}`);
  await fillAndSubmit();
  const before = (await app.request(`${path}/responses`)).body;
  assert.equal(before.count, 1);
  for (const field of form.fields) assert.ok(before.responses[0].answers[field.id]);
  const refresh = async count => {
    await manager.getByRole('button', { name: 'Обновить отклики и аналитику', exact: true }).click();
    await manager.getByRole('heading', { name: `Отклики (${count})`, exact: true }).waitFor();
    for (const [caption, value] of [['Просмотры', count], ['Начатые заполнения', count], ['Отправленные отклики', count], ['В процессе', 0], ['Незавершённые заполнения', 0]]) {
      const metric = manager.getByRole('term').filter({ hasText: new RegExp(`^${caption}$`) });
      assert.equal(await metric.locator('..').getByRole('definition').innerText(), String(value));
    }
    const replies = manager.getByRole('region', { name: `Отклики (${count})` });
    for (const value of Object.values(before.responses[0].answers)) {
      assert.ok((await replies.innerText()).includes(typeof value === 'string' ? value : value.name));
    }
    assert.equal(await manager.locator('img').count(), 0);
    assert.equal(await manager.evaluate(() => window.executed), undefined);
  };
  await refresh(1);
  assert.equal(await student.locator('img').count(), 0);
  assert.equal(await student.evaluate(() => window.executed), undefined);
  assert.equal((await app.request(path, 'PATCH', { title: 'Подмена' })).status, 409);
  await manager.getByRole('button', { name: 'Закрыть приём', exact: true }).click();
  await manager.getByRole('status').filter({ hasText: 'Приём завершён' }).waitFor();
  await student.reload();
  await student.getByRole('heading', { name: 'Приём завершён', exact: true }).waitFor();
  assert.equal(await student.getByRole('button', { name: 'Отправить отклик', exact: true }).count(), 0);
  const stats = (await app.request(`${path}/analytics`)).body;
  await app.stop();
  app = await start(cwd, offline);
  assert.deepEqual((await app.request(path)).body, { ...form, status: 'closed' });
  assert.deepEqual((await app.request(`${path}/responses`)).body, before);
  assert.deepEqual((await app.request(`${path}/analytics`)).body, stats);
  assert.equal((await app.request(path, 'PATCH', { fields: [] })).status, 409);
  await manager.goto(`${app.url}/admin#${form.id}`);
  await manager.getByRole('button', { name: 'Открыть приём снова', exact: true }).click();
  await manager.getByRole('status').filter({ hasText: 'Опубликована' }).waitFor();
  assert.deepEqual((await app.request(path)).body, form);
  assert.equal((await app.request(path, 'PATCH', { title: 'Подмена' })).status, 409);
  await student.goto(`${app.url}${form.publicUrl}`);
  await fillAndSubmit();
  await refresh(2);
  const after = (await app.request(`${path}/responses`)).body;
  assert.equal(after.count, 2);
  assert.deepEqual(after.responses[0], before.responses[0]);
  assert.notEqual(after.responses[0].attemptId, after.responses[1].attemptId);
  assert.deepEqual(external, []);
});
