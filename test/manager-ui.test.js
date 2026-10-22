import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { start } from '../test-support/server.js';

test('затруднения показывают только применимые к типу и обязательности поля проверки', { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const checks = [
    ['short_text', []],
    ['long_text', []],
    ['single_choice', []],
    ['multiple_choice', []],
    ['email', ['Некорректный email']],
    ['city', ['Вариант из справочника не выбран', 'Поиск не дал результатов', 'Ошибка загрузки справочника']],
    ['university', ['Вариант из справочника не выбран', 'Поиск не дал результатов', 'Ошибка загрузки справочника']],
    ['study_direction', ['Вариант из справочника не выбран', 'Поиск не дал результатов', 'Ошибка загрузки справочника']],
    ['study_level_course', ['Ошибка загрузки справочника']],
  ];
  const fields = checks.flatMap(([type]) => [false, true].map(required => ({
    id: `${type}-${required}`, type, label: `${type}-${required}`, required,
    ...(['single_choice', 'multiple_choice'].includes(type) ? { options: ['Да', 'Нет'] } : {}),
  })));
  const draft = await app.request('/api/forms', 'POST', { title: 'Проверки полей', fields });
  assert.equal(draft.status, 201);
  await app.request(`/api/forms/${draft.body.id}/publish`, 'POST');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.goto(`${app.url}/admin#${draft.body.id}`);
  await page.getByRole('heading', { name: 'Затруднения по полям', exact: true }).waitFor();
  const emptyUnfinished = page.getByRole('region', { name: 'Незавершённые заполнения по вопросам', exact: true });
  assert.deepEqual(await emptyUnfinished.getByRole('definition').allTextContents(), fields.map(() => '0'));
  for (const [type, captions] of checks) {
    for (const required of [false, true]) {
      const expected = [...(required ? ['Обязательное поле не заполнено'] : []), ...captions];
      const heading = page.getByRole('heading', { name: `${type}-${required}`, exact: true });
      if (!expected.length) assert.equal(await heading.count(), 0);
      else assert.deepEqual(await heading.locator('..').getByRole('term').allTextContents(), expected);
    }
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const collapse = page.getByRole('button', { name: 'Свернуть аналитику', exact: true });
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
  const statsId = await collapse.getAttribute('aria-controls');
  await collapse.focus();
  await collapse.press('Enter');
  const expand = page.getByRole('button', { name: 'Развернуть аналитику', exact: true });
  assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator(`#${statsId}`).isVisible(), false);
  assert.equal(await page.getByRole('heading', { name: 'Аналитика заполнений', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('region', { name: 'Отклики (0)', exact: true }).isVisible(), true);
  await expand.press('Space');
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator(`#${statsId}`).isVisible(), true);
  await page.getByRole('heading', { name: 'Воронка отправки', exact: true }).waitFor();
  const textOnly = (await app.request('/api/forms', 'POST', {
    title: 'Необязательный текст', fields: [{ id: 'text', type: 'short_text', label: 'Комментарий', required: false }],
  })).body;
  await app.request(`/api/forms/${textOnly.id}/publish`, 'POST');
  await page.goto(`${app.url}/admin#${textOnly.id}`);
  await page.getByText('Для вопросов этой формы нет отдельных проверок.', { exact: true }).waitFor();
});

test('публикация фиксирует содержание, управление приёмом сохраняет ссылку, отклики и аналитику', { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const now = Date.parse('2026-10-22T12:00:00Z');
  await writeFile(resolve(cwd, 'clock'), String(now));
  const app = await start(cwd, ['--import', new URL('../test-support/clock.js', import.meta.url).href]);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const unsafe = '<img src=x onerror="window.executed=true">';
  const fields = [
    { id: 'name', type: 'short_text', label: unsafe, required: true },
    { id: 'about', type: 'long_text', label: 'О себе', required: false },
    { id: 'email', type: 'email', label: 'Почта', required: false },
    { id: 'format', type: 'single_choice', label: 'Формат', required: false, options: ['Очно', 'Удалённо'] },
    { id: 'city', type: 'city', label: 'Город', required: false },
    { id: 'university', type: 'university', label: 'Вуз', required: false },
    { id: 'direction', type: 'study_direction', label: 'Направление', required: false },
    { id: 'course', type: 'study_level_course', label: 'Курс', required: false },
  ];
  const draft = (await app.request('/api/forms', 'POST', { title: 'Набор студентов', fields })).body;
  await page.goto(`${app.url}/admin#${draft.id}`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Опубликовать форму', exact: true }).click();
  await page.getByRole('heading', { name: 'Содержание формы', exact: true }).waitFor();
  const schema = page.getByRole('heading', { name: 'Содержание формы', exact: true }).locator('..');
  assert.equal(await schema.getByRole('article').count(), fields.length);
  assert.deepEqual(await schema.getByRole('heading', { level: 3 }).allTextContents(), fields.map((field, index) => `Вопрос ${index + 1}. ${field.label}`));
  assert.ok((await schema.getByRole('article').nth(0).innerText()).includes('Короткий текст · Обязательное'));
  assert.ok((await schema.getByRole('article').nth(3).innerText()).includes('Очно\nУдалённо'));
  await page.getByRole('heading', { name: 'Отклики (0)', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Название формы', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Добавить поле', exact: true }).count(), 0);
  const published = (await app.request(`/api/forms/${draft.id}`)).body;
  const publicLink = page.getByRole('link', { name: `${app.url}${published.publicUrl}`, exact: true });
  assert.equal(await publicLink.getAttribute('href'), `${app.url}${published.publicUrl}`);

  const city = (await app.request('/api/catalogs/cities?q=Москва')).body.items[0];
  const university = (await app.request('/api/catalogs/universities')).body.items[0];
  const direction = (await app.request('/api/catalogs/study-directions')).body.items[0];
  const course = (await app.request(`/api/catalogs/study-courses?directionId=${direction.id}`)).body.items[0];
  const sent = (await app.request(`${published.publicUrl}/attempts`, 'POST', {})).body;
  await app.request(`${published.publicUrl}/attempts/${sent.id}/events`, 'POST', { type: 'change', fieldId: 'name' });
  for (const type of ['submit', 'validation_failed', 'request_failed']) {
    await app.request(`${published.publicUrl}/attempts/${sent.id}/events`, 'POST', { type });
  }
  await app.request(`${published.publicUrl}/attempts/${sent.id}/events`, 'POST', { type: 'search_empty', fieldId: 'university' });
  const response = await app.request(`${published.publicUrl}/responses`, 'POST', { attemptId: sent.id, answers: {
    name: unsafe, about: 'Две строки\nОб опыте', email: 'student@example.com', format: 'Удалённо',
    city: city.id, university: university.id, direction: direction.id, course: course.id,
  } });
  assert.equal(response.status, 201);
  const abandoned = (await app.request(`${published.publicUrl}/attempts`, 'POST', {})).body;
  await app.request(`${published.publicUrl}/attempts/${abandoned.id}/events`, 'POST', { type: 'change', fieldId: 'name' });
  await app.request(`${published.publicUrl}/attempts`, 'POST', {});
  await writeFile(resolve(cwd, 'clock'), String(now + 30 * 60 * 1000));
  const active = (await app.request(`${published.publicUrl}/attempts`, 'POST', {})).body;
  await app.request(`${published.publicUrl}/attempts/${active.id}/events`, 'POST', { type: 'change', fieldId: 'email' });
  await page.getByRole('button', { name: 'Обновить отклики и аналитику', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклики (1)', exact: true }).waitFor();
  for (const [caption, expected] of [['Просмотры', '4'], ['Начатые заполнения', '3'], ['Отправленные отклики', '1'], ['В процессе', '1'], ['Незавершённые заполнения', '1'], ['Нажали отправить', '1'], ['Ошибка проверки', '1'], ['Сбой запроса отправки', '1'], ['Отклик принят', '1']]) {
    const metric = page.getByRole('term').filter({ hasText: new RegExp(`^${caption}$`) });
    assert.equal(await metric.locator('..').getByRole('definition').innerText(), expected);
  }
  const replies = page.getByRole('region', { name: 'Отклики (1)' });
  for (const text of [unsafe, 'Две строки\nОб опыте', 'student@example.com', 'Удалённо', city.name, university.name, direction.name, course.name]) {
    assert.ok((await replies.innerText()).includes(text), text);
  }
  const unfinished = page.getByRole('region', { name: 'Незавершённые заполнения по вопросам', exact: true });
  assert.deepEqual(await unfinished.getByRole('term').allTextContents(), fields.map((field, index) => `Вопрос ${index + 1}: «${field.label}»`));
  assert.deepEqual(await unfinished.getByRole('definition').allTextContents(), ['1', '0', '0', '0', '0', '0', '0', '0']);
  assert.ok(!(await page.locator('body').innerText()).includes(abandoned.id));
  await page.getByRole('heading', { name: 'Воронка отправки', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Затруднения по полям', exact: true }).waitFor();
  const universityIssues = page.getByRole('heading', { name: 'Вуз', exact: true }).locator('..');
  const emptySearch = universityIssues.getByRole('term').filter({ hasText: 'Поиск не дал результатов' }).locator('..');
  assert.equal(await emptySearch.getByRole('definition').innerText(), '1 из 4\n25%');
  assert.equal(await emptySearch.locator('.issue-bar > span').evaluate(node => node.style.width), '25%');
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.executed), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  const another = (await app.request(`${published.publicUrl}/attempts`, 'POST', {})).body;
  await app.request(`${published.publicUrl}/attempts/${another.id}/events`, 'POST', { type: 'change', fieldId: 'name' });
  await writeFile(resolve(cwd, 'clock'), String(now + 60 * 60 * 1000));
  await page.getByRole('button', { name: 'Обновить отклики и аналитику', exact: true }).click();
  await unfinished.getByRole('definition').filter({ hasText: /^2$/ }).waitFor();
  assert.deepEqual(await unfinished.getByRole('term').allTextContents(), fields.map((field, index) => `Вопрос ${index + 1}: «${field.label}»`));
  assert.deepEqual(await unfinished.getByRole('definition').allTextContents(), ['2', '0', '1', '0', '0', '0', '0', '0']);
  for (const id of [abandoned.id, another.id, active.id]) assert.ok(!(await unfinished.innerText()).includes(id));
  assert.equal(await unfinished.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  await page.getByRole('button', { name: 'Закрыть приём', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Приём завершён' }).waitFor();
  await page.getByRole('link', { name: 'Все формы', exact: true }).click();
  await page.getByRole('article').getByText('Приём завершён', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Набор студентов', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Отклики (1)', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await publicLink.getAttribute('href'), `${app.url}${published.publicUrl}`);
  await page.getByRole('button', { name: 'Открыть приём снова', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Опубликована' }).waitFor();
  await page.getByRole('link', { name: 'Все формы', exact: true }).click();
  await page.getByRole('article').getByText('Опубликована', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Набор студентов', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Отклики (1)', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await publicLink.getAttribute('href'), `${app.url}${published.publicUrl}`);
});
