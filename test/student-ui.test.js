import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { start } from '../test-support/server.js';

async function setup(t, fields) {
  const cwd = await mkdtemp(resolve('.test-data-'));
  const app = await start(cwd);
  t.after(async () => { await app.stop(); await rm(cwd, { recursive: true, force: true }); });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const draft = (await app.request('/api/forms', 'POST', { title: 'Стажировка', fields })).body;
  const form = (await app.request(`/api/forms/${draft.id}/publish`, 'POST')).body;
  return { app, form, page, context };
}

test('студент исправляет ошибки, отправляет отклик и намеренно заполняет форму повторно', { timeout: 30000 }, async t => {
  const { app, form, page } = await setup(t, [
    { id: 'name', type: 'short_text', label: 'Имя', required: true },
    { id: 'email', type: 'email', label: 'Почта', required: true },
    { id: 'about', type: 'long_text', label: 'О себе', required: false },
    { id: 'format', type: 'single_choice', label: 'Формат', required: false, options: ['Очно', 'Удалённо'] },
  ]);
  await page.goto(`${app.url}${form.publicUrl}`);
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByText('Заполните обязательное поле.', { exact: true }).first().waitFor();
  await page.getByLabel('Имя', { exact: false }).fill('Анна');
  await page.getByLabel('Почта', { exact: false }).fill('anna@invalid');
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByText('Введите корректный email.', { exact: true }).waitFor();
  await page.getByLabel('Почта', { exact: false }).fill('anna@example.com');
  await page.getByLabel('О себе', { exact: false }).fill('Хочу учиться\nИ работать');
  await page.getByLabel('Формат', { exact: false }).selectOption('Удалённо');
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  let replies = (await app.request(`/api/forms/${form.id}/responses`)).body;
  assert.equal(replies.count, 1);
  assert.deepEqual(replies.responses[0].answers, { name: 'Анна', email: 'anna@example.com', about: 'Хочу учиться\nИ работать', format: 'Удалённо' });
  await page.reload();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Заполнить ещё раз', exact: true }).click();
  assert.equal(await page.getByLabel('Имя', { exact: false }).inputValue(), '');
  await page.getByLabel('Имя', { exact: false }).fill('Борис');
  await page.getByLabel('Почта', { exact: false }).fill('boris@example.com');
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  replies = (await app.request(`/api/forms/${form.id}/responses`)).body;
  assert.equal(replies.count, 2);
  assert.notEqual(replies.responses[0].attemptId, replies.responses[1].attemptId);
});

for (const [type, label, catalog, query] of [
  ['city', 'Город', 'cities', 'Моск'],
  ['university', 'Вуз', 'universities', 'Московский'],
  ['study_direction', 'Направление', 'study-directions', '09.04'],
]) {
  test(`${label}: подсказки открываются по запросу, выбор заменяет текст, изменение и очистка сбрасывают выбор`, { timeout: 30000 }, async t => {
    const { app, form, page } = await setup(t, [{ id: 'reference', type, label, required: false }]);
    const entry = (await app.request(`/api/catalogs/${catalog}?q=${encodeURIComponent(query)}`)).body.items[0];
    const fullName = type === 'city' ? `${entry.name} · ${entry.region}` :
      type === 'study_direction' ? `${entry.code} · ${entry.name} · Магистратура` : entry.name;
    await page.goto(`${app.url}${form.publicUrl}`);
    const search = page.getByLabel(`${label} ·`, { exact: false });
    const choices = page.getByRole('listbox', { name: `Варианты: ${label}`, exact: true });
    await search.waitFor();
    assert.equal(await choices.count(), 0);
    await search.fill('   ');
    assert.equal(await choices.count(), 0);
    await search.fill(query);
    await choices.getByRole('option', { name: fullName, exact: true }).waitFor();
    await choices.selectOption(entry.id);
    assert.equal(await search.inputValue(), fullName);
    assert.equal(await page.getByText(/^Выбрано:/).count(), 0);
    assert.equal(await choices.count(), 0);
    assert.equal(await search.isVisible(), true);

    await search.fill('НетТакогоВарианта');
    await page.getByText('Нет нужного варианта? Свяжитесь с организатором', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
    await page.getByText('Выберите значение из справочника.', { exact: true }).waitFor();
    assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 0);

    await search.fill(query);
    await choices.getByRole('option', { name: fullName, exact: true }).waitFor();
    await choices.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await choices.isVisible(), true);
    assert.notEqual(await choices.inputValue(), entry.id);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    assert.equal(await search.inputValue(), fullName);
    assert.equal(await choices.count(), 0);
    await search.fill(query);
    await choices.getByRole('option', { name: fullName, exact: true }).waitFor();
    await choices.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await choices.getByRole('option', { name: fullName, exact: true }).click();
    assert.equal(await choices.count(), 0);
    await search.fill('');
    assert.equal(await choices.count(), 0);
    await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
    await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
    let replies = (await app.request(`/api/forms/${form.id}/responses`)).body;
    assert.deepEqual(replies.responses[0].answers, {});

    await page.getByRole('button', { name: 'Заполнить ещё раз', exact: true }).click();
    await search.fill(query);
    await choices.getByRole('option', { name: fullName, exact: true }).waitFor();
    await choices.selectOption(entry.id);
    const sent = page.waitForRequest(request => request.url().endsWith('/responses') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
    assert.deepEqual((await sent).postDataJSON().answers, { reference: entry.id });
    await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
    replies = (await app.request(`/api/forms/${form.id}/responses`)).body;
    assert.equal(replies.responses.find(response => response.answers.reference)?.answers.reference.id, entry.id);
  });
}

test('поиск справочников доступен с клавиатуры, курс соответствует направлению', { timeout: 30000 }, async t => {
  const { app, form, page } = await setup(t, [
    { id: 'city', type: 'city', label: 'Город', required: true },
    { id: 'university', type: 'university', label: 'Вуз', required: false },
    { id: 'direction', type: 'study_direction', label: 'Направление', required: false },
    { id: 'course', type: 'study_level_course', label: 'Курс', required: false },
  ]);
  await page.goto(`${app.url}${form.publicUrl}`);
  const courses = page.getByLabel('Курс ·', { exact: false });
  await courses.waitFor();
  assert.equal(await courses.locator('option').count(), 12);
  for (const name of ['Бакалавриат — 4 курс и выше (4+)', 'Магистратура — 2 курс и выше (2+)', 'Специалитет — 5 курс и выше (5+)']) {
    assert.equal(await courses.getByRole('option', { name, exact: true }).count(), 1);
  }
  await page.getByLabel('Город ·', { exact: false }).fill('НетТакогоГорода');
  await page.getByText('Нет нужного варианта? Свяжитесь с организатором', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByText('Выберите значение из справочника.', { exact: true }).waitFor();
  const city = (await app.request('/api/catalogs/cities?q=Москва')).body.items[0];
  await page.getByLabel('Город ·', { exact: false }).fill('Москва');
  const cityOptions = page.getByRole('listbox', { name: 'Варианты: Город', exact: true });
  await cityOptions.getByRole('option', { name: `${city.name} · ${city.region}`, exact: true }).waitFor();
  await cityOptions.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Город ·', { exact: false }).inputValue(), `${city.name} · ${city.region}`);
  const bachelor = (await app.request('/api/catalogs/study-courses')).body.items.find(item => item.name === 'Бакалавриат — 4 курс и выше (4+)');
  await courses.selectOption(bachelor.id);
  const direction = (await app.request('/api/catalogs/study-directions?q=09.04.01')).body.items[0];
  await page.getByLabel('Направление ·', { exact: false }).fill('09.04.01');
  const directions = page.getByRole('listbox', { name: 'Варианты: Направление', exact: true });
  await directions.getByRole('option', { name: `${direction.code} · ${direction.name} · Магистратура`, exact: true }).waitFor();
  await directions.selectOption(direction.id);
  assert.equal(await courses.inputValue(), '');
  assert.deepEqual(await courses.locator('option').allTextContents(), ['Выберите вариант', 'Магистратура — 1 курс', 'Магистратура — 2 курс и выше (2+)']);
  const master = (await app.request(`/api/catalogs/study-courses?directionId=${direction.id}`)).body.items.find(item => item.course === '2+');
  await courses.selectOption(master.id);
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  const replies = (await app.request(`/api/forms/${form.id}/responses`)).body;
  assert.equal(replies.responses[0].answers.city.id, city.id);
  assert.equal(replies.responses[0].answers.direction.id, direction.id);
  assert.equal(replies.responses[0].answers.course.id, master.id);
  assert.equal(Object.hasOwn(replies.responses[0].answers, 'university'), false);
});

test('попытка продолжается после обновления без ответов, вкладки независимы, аналитика не содержит значений', { timeout: 30000 }, async t => {
  const { app, form, page, context } = await setup(t, [
    { id: 'name', type: 'short_text', label: 'Имя', required: true },
    { id: 'about', type: 'long_text', label: 'О себе', required: false },
  ]);
  const events = [];
  page.on('request', request => {
    if (request.url().endsWith('/events')) events.push(request.postDataJSON());
  });
  const stats = () => app.request(`/api/forms/${form.id}/analytics`).then(result => result.body);
  await page.goto(`${app.url}${form.publicUrl}`);
  await page.getByLabel('Имя ·', { exact: false }).focus();
  assert.equal((await stats()).views, 1);
  assert.equal((await stats()).starts, 0);
  const changed = page.waitForResponse(response => response.url().endsWith('/events') && response.request().postDataJSON().type === 'change');
  await page.getByLabel('Имя ·', { exact: false }).fill('СЕКРЕТНЫЙ ТЕКСТ');
  await changed;
  assert.equal((await stats()).starts, 1);
  const focused = page.waitForResponse(response => response.url().endsWith('/events') && response.request().postDataJSON().fieldId === 'about');
  await page.getByLabel('О себе ·', { exact: false }).focus();
  await focused;
  assert.ok(events.some(event => event.type === 'focus' && event.fieldId === 'about'));
  assert.ok(events.every(event => Object.keys(event).sort().join() === 'fieldId,type'));
  assert.equal(JSON.stringify(events).includes('СЕКРЕТНЫЙ ТЕКСТ'), false);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }));
  assert.deepEqual(storage.local, {});
  assert.deepEqual(storage.session, {});
  assert.equal(JSON.stringify(storage.state).includes('СЕКРЕТНЫЙ ТЕКСТ'), false);
  await page.reload();
  await page.getByLabel('Имя ·', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Имя ·', { exact: false }).inputValue(), '');
  assert.equal((await stats()).views, 1);
  const other = await context.newPage();
  await other.goto(`${app.url}${form.publicUrl}`);
  await other.getByLabel('Имя ·', { exact: false }).waitFor();
  assert.equal((await stats()).views, 2);
  assert.equal((await stats()).starts, 1);
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(url => window.open(url, '_blank'), `${app.url}${form.publicUrl}`);
  const popup = await popupPromise;
  await popup.getByLabel('Имя ·', { exact: false }).waitFor();
  assert.equal((await stats()).views, 3);
});

test('ошибка отправки сохраняет ответы, повтор не создаёт дубль, закрытие объясняется студенту', { timeout: 30000 }, async t => {
  const { app, form, page } = await setup(t, [{ id: 'name', type: 'short_text', label: 'Имя', required: true }]);
  await page.goto(`${app.url}${form.publicUrl}`);
  await page.getByLabel('Имя ·', { exact: false }).fill('Анна');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route('**/responses', async route => {
    await blocked;
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Отправка отклика' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Отправить отклик', exact: true }).isDisabled(), true);
  release();
  await page.getByRole('alert').filter({ hasText: 'Проверьте соединение' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Имя ·', { exact: false }).inputValue(), 'Анна');
  await page.unroute('**/responses');
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 1);
  await page.getByRole('button', { name: 'Заполнить ещё раз', exact: true }).click();
  await page.getByLabel('Имя ·', { exact: false }).fill('Борис');
  await app.request(`/api/forms/${form.id}/close`, 'POST');
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Приём завершён' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).count(), 0);
  assert.equal((await app.request(`/api/forms/${form.id}/responses`)).body.count, 1);
  await page.reload();
  await page.getByRole('heading', { name: 'Приём завершён', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Отправить отклик', exact: true }).count(), 0);
});

test('пользовательский текст безопасен на узком экране, вуз и курс работают без направления', { timeout: 30000 }, async t => {
  const unsafe = '<img src=x onerror="window.executed=true">';
  const { app, form, page } = await setup(t, [
    { id: '__proto__', type: 'short_text', label: unsafe, required: true },
    { id: 'choice', type: 'single_choice', label: 'Формат', required: false, options: [unsafe] },
    { id: 'university', type: 'university', label: 'Вуз', required: false },
    { id: 'course', type: 'study_level_course', label: 'Курс', required: true },
  ]);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${app.url}${form.publicUrl}`);
  await page.getByLabel(`${unsafe} ·`, { exact: false }).fill(unsafe);
  await page.getByLabel('Формат ·', { exact: false }).selectOption({ label: unsafe });
  const university = (await app.request('/api/catalogs/universities?q=Московский')).body.items[0];
  await page.getByLabel('Вуз ·', { exact: false }).fill(university.name);
  const choices = page.getByRole('listbox', { name: 'Варианты: Вуз', exact: true });
  await choices.getByRole('option', { name: university.name, exact: true }).waitFor();
  await choices.selectOption(university.id);
  await page.getByLabel('Курс ·', { exact: false }).selectOption('specialist-5plus');
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.executed), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Отправить отклик', exact: true }).click();
  await page.getByRole('heading', { name: 'Отклик отправлен', exact: true }).waitFor();
  const response = (await app.request(`/api/forms/${form.id}/responses`)).body.responses[0];
  assert.equal(response.answers.__proto__, unsafe);
  assert.equal(response.answers.university.id, university.id);
  assert.equal(response.answers.course.id, 'specialist-5plus');
});
