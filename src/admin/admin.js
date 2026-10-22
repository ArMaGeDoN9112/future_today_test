/** @typedef {import('../server.js').Form} Form */
/** @typedef {import('../server.js').Field} Field */
/** @typedef {import('../server.js').FormResponse} FormResponse */

const content = /** @type {HTMLDivElement} */ (document.querySelector('#content'));
const message = /** @type {HTMLDivElement} */ (document.querySelector('#message'));
const error = /** @type {HTMLParagraphElement} */ (document.querySelector('#error'));
const statuses = { draft: 'Черновик', published: 'Опубликована', closed: 'Приём завершён' };
const types = {
  short_text: 'Короткий текст', long_text: 'Длинный текст', email: 'Email', single_choice: 'Один вариант',
  multiple_choice: 'Несколько вариантов',
  city: 'Город проживания', university: 'Вуз', study_direction: 'Направление обучения', study_level_course: 'Уровень и курс обучения',
};
const levels = { bachelor: 'Бакалавриат', master: 'Магистратура', specialist: 'Специалитет' };
let busy = false;
let pendingNavigation = false;

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] */
function el(tag, text = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/** @param {string} text @param {() => void} action @param {boolean} [primary] */
function button(text, action, primary = false) {
  const node = el('button', text);
  node.type = 'button';
  node.className = primary ? 'primary' : '';
  node.onclick = action;
  return node;
}

/** @param {string} path @param {string} [method] @param {unknown} [body] */
async function api(path, method = 'GET', body = undefined) {
  const response = await fetch(path, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new Error('Не удалось связаться с сервером. Проверьте соединение и повторите действие.'); });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}

/** @param {() => Promise<void>} action @param {string} loading */
async function run(action, loading) {
  if (busy) return;
  busy = true;
  error.hidden = true;
  message.textContent = loading;
  content.setAttribute('aria-busy', 'true');
  const controls = [...content.querySelectorAll('button, input, select, textarea')].map(element => {
    const node = /** @type {HTMLButtonElement} */ (element);
    const disabled = node.disabled;
    node.disabled = true;
    return { node, disabled };
  });
  try { await action(); }
  catch (cause) {
    message.textContent = '';
    error.textContent = cause instanceof Error ? cause.message : 'Ошибка соединения. Повторите действие.';
    error.hidden = false;
    if (!content.children.length) content.append(button('Повторить загрузку', () => { void navigate(); }));
  } finally {
    busy = false;
    content.removeAttribute('aria-busy');
    for (const { node, disabled } of controls) if (node.isConnected) node.disabled = disabled;
    if (pendingNavigation) { pendingNavigation = false; void navigate(); }
  }
}

/** @param {string} text @param {HTMLElement} control */
function label(text, control) {
  const group = el('div');
  const caption = el('label', text);
  control.id = crypto.randomUUID();
  caption.htmlFor = control.id;
  group.append(caption, control);
  return group;
}

/** @param {string} text @param {string} href */
function link(text, href) {
  const node = el('a', text);
  node.href = href;
  return node;
}

/** @param {Form} form */
function heading(form) {
  const back = link('Все формы', '#');
  back.className = 'back';
  const badge = el('span', statuses[form.status]);
  badge.className = 'badge';
  content.replaceChildren(back, el('h1', form.title), badge);
}

async function list() {
  const forms = /** @type {Form[]} */ (await api('/api/forms'));
  content.replaceChildren(el('h1', 'Мои формы'), el('p', 'Создавайте формы отклика и следите за заполнениями.'));
  content.append(button('Создать форму', () => { location.hash = 'new'; }, true));
  if (!forms.length) content.append(el('p', 'Пока нет форм. Создайте первую форму отклика.'));
  for (const form of forms) {
    const card = el('article');
    card.className = 'card';
    const title = el('h2');
    title.append(link(form.title, `#${form.id}`));
    const badge = el('span', statuses[form.status]);
    badge.className = 'badge';
    card.append(title, badge);
    content.append(card);
  }
}

/** @param {Form | null} form */
function editor(form) {
  if (form) heading(form);
  else content.replaceChildren(link('Все формы', '#'), el('h1', 'Новая форма'));
  const editorForm = el('form');
  editorForm.className = 'card';
  const title = el('input');
  title.value = form?.title ?? '';
  title.required = true;
  const fields = el('div');
  /** @type {HTMLButtonElement | null} */
  let publish = null;
  function changed() { if (publish) publish.disabled = true; }
  editorForm.addEventListener('input', changed);
  editorForm.append(label('Название формы', title), fields);

  /** @param {Field} field */
  function addField(field) {
    const group = el('fieldset');
    const legend = el('legend');
    const caption = el('input');
    caption.value = field.label;
    caption.required = true;
    const type = el('select');
    for (const [value, name] of Object.entries(types)) {
      const option = el('option', name);
      option.value = value;
      type.append(option);
    }
    type.value = field.type;
    const required = el('input');
    required.type = 'checkbox';
    required.checked = field.required;
    const options = el('div');
    options.className = 'choice-options';
    const optionsGroup = el('div');
    const addOptionButton = button('+ Добавить вариант', () => { addOption('').focus(); changed(); });
    optionsGroup.append(el('p', 'Варианты ответа'), options, addOptionButton);
    function renumberOptions() {
      [...options.children].forEach((row, index) => {
        /** @type {HTMLLabelElement} */ (row.querySelector('label')).textContent = `Вариант ${index + 1}`;
        const remove = /** @type {HTMLButtonElement} */ (row.querySelector('button'));
        remove.setAttribute('aria-label', `Удалить вариант ${index + 1}`);
        remove.disabled = options.children.length === 1;
      });
    }
    /** @param {string} value */
    function addOption(value) {
      const input = el('input');
      input.value = value;
      input.required = ['single_choice', 'multiple_choice'].includes(type.value);
      const row = el('div');
      row.className = 'choice-option';
      row.append(label('', input), button('×', () => {
        const next = row.nextElementSibling ?? row.previousElementSibling;
        row.remove();
        renumberOptions();
        next?.querySelector('input')?.focus();
        changed();
      }));
      options.append(row);
      renumberOptions();
      return input;
    }
    for (const value of field.options?.length ? field.options : ['']) addOption(value);
    function updateOptions() {
      optionsGroup.hidden = !['single_choice', 'multiple_choice'].includes(type.value);
      for (const input of options.querySelectorAll('input')) input.required = !optionsGroup.hidden;
    }
    type.onchange = updateOptions;
    updateOptions();
    const remove = button('Удалить поле', () => { group.remove(); renumber(); changed(); });
    group.dataset.id = field.id;
    group.append(legend, label('Подпись поля', caption), label('Тип поля', type), label('Обязательное поле', required), optionsGroup, remove);
    fields.append(group);
    renumber();
  }

  function renumber() {
    [...fields.children].forEach((group, index) => {
      /** @type {HTMLLegendElement} */ (group.querySelector('legend')).textContent = `Поле ${index + 1}`;
      /** @type {HTMLButtonElement} */ (group.querySelector(':scope > button')).textContent = `Удалить поле ${index + 1}`;
    });
  }
  for (const field of form?.fields ?? []) addField(field);
  const actions = el('div');
  actions.className = 'actions';
  const save = el('button', 'Сохранить черновик');
  save.type = 'submit';
  save.className = 'primary';
  actions.append(button('Добавить поле', () => { addField({ id: crypto.randomUUID(), label: '', type: 'short_text', required: false }); changed(); }), save);
  editorForm.append(actions);
  editorForm.onsubmit = event => {
    event.preventDefault();
    const draft = {
      title: title.value,
      fields: [...fields.children].map(group => {
        const inputs = group.querySelectorAll('input');
        const type = /** @type {HTMLSelectElement} */ (group.querySelector('select')).value;
        return {
          id: /** @type {HTMLElement} */ (group).dataset.id, label: inputs[0].value, type, required: inputs[1].checked,
          ...(['single_choice', 'multiple_choice'].includes(type) ? { options: [...group.querySelectorAll('.choice-options input')].map(input => /** @type {HTMLInputElement} */ (input).value.trim()) } : {}),
        };
      }),
    };
    void run(async () => {
      const saved = await api(form ? `/api/forms/${form.id}` : '/api/forms', form ? 'PATCH' : 'POST', draft);
      editor(saved);
      history.replaceState(null, '', `#${saved.id}`);
      message.textContent = 'Черновик сохранён';
    }, 'Сохранение черновика…');
  };
  content.append(editorForm);
  if (form) {
    content.append(el('p', 'Перед публикацией сохраните изменения. Публикация зафиксирует сохранённые название и поля навсегда, включая закрытие и повторное открытие приёма.'));
    publish = button('Опубликовать форму', () => {
      if (!window.confirm('Опубликовать сохранённый черновик? Содержание больше нельзя будет изменить.')) return;
      void run(async () => {
        const published = await api(`/api/forms/${form.id}/publish`, 'POST');
        await publishedView(published);
        message.textContent = 'Форма опубликована. Содержание зафиксировано.';
      }, 'Публикация…');
    });
    content.append(publish);
  }
}

/** @param {FormResponse['answers'][string] | undefined} value */
function answer(value) {
  if (value === undefined) return 'Не заполнено';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  return [value.code, value.name, value.region, value.level && levels[value.level], value.course && `${value.course} курс`].filter(Boolean).join(' · ');
}

/** @param {Form} form */
async function publishedView(form) {
  heading(form);
  content.append(el('p', 'Содержание зафиксировано при публикации и недоступно для редактирования.'));
  if (form.publicUrl) {
    const url = new URL(form.publicUrl, location.origin).href;
    const paragraph = el('p', 'Ссылка для студентов: ');
    paragraph.append(link(url, url));
    content.append(paragraph);
  }
  const schema = el('section');
  schema.append(el('h2', 'Содержание формы'));
  for (const field of form.fields) {
    const description = el('dl');
    description.append(el('dt', field.label), el('dd', `${types[/** @type {keyof typeof types} */ (field.type)]} · ${field.required ? 'Обязательное' : 'Необязательное'}`));
    if (field.options) description.append(el('dt', 'Варианты ответа'), el('dd', field.options.join('\n')));
    schema.append(description);
  }
  if (!form.fields.length) schema.append(el('p', 'В форме нет полей.'));
  content.append(schema);
  const actions = el('div');
  actions.className = 'actions';
  actions.append(button(form.status === 'published' ? 'Закрыть приём' : 'Открыть приём снова', () => {
    void run(async () => {
      const updated = /** @type {Form} */ (await api(`/api/forms/${form.id}/${form.status === 'published' ? 'close' : 'reopen'}`, 'POST'));
      await publishedView(updated);
      message.textContent = statuses[updated.status];
    }, 'Сохранение состояния…');
  }), button('Обновить отклики и аналитику', () => { void run(async () => { await publishedView(form); message.textContent = 'Данные обновлены'; }, 'Обновление…'); }));
  content.append(actions);
  const results = el('div');
  results.textContent = 'Загрузка откликов и аналитики…';
  content.append(results);
  const [responses, analytics] = await Promise.all([api(`/api/forms/${form.id}/responses`), api(`/api/forms/${form.id}/analytics`)]).catch(cause => {
    results.textContent = 'Данные не загружены. Нажмите «Обновить отклики и аналитику», чтобы повторить.';
    throw cause;
  });
  results.replaceChildren();
  const stats = el('section');
  stats.append(el('h2', 'Аналитика заполнений'));
  const metrics = el('dl');
  metrics.className = 'metrics';
  for (const [key, caption] of Object.entries({ views: 'Просмотры', starts: 'Начатые заполнения', submissions: 'Отправленные отклики', inProgress: 'В процессе', abandoned: 'Незавершённые заполнения' })) {
    const item = el('div');
    item.className = 'metric';
    item.append(el('dt', caption), el('dd', String(analytics[key])));
    metrics.append(item);
  }
  stats.append(metrics, el('p', 'Учитываются попытки заполнения, а не уникальные люди. Начатое заполнение без отклика становится незавершённым после 30 минут бездействия. Просмотр без изменений не считается незавершённым. Поздняя отправка корректирует показатели.'));
  stats.append(el('h3', 'Воронка отправки'));
  const funnel = el('dl');
  funnel.className = 'metrics';
  for (const [key, caption] of Object.entries({ clicked: 'Нажали отправить', validationFailed: 'Ошибка проверки', requestFailed: 'Сбой запроса отправки', accepted: 'Отклик принят' })) {
    const item = el('div');
    item.className = 'metric';
    item.append(el('dt', caption), el('dd', String(analytics.submissionFunnel[key])));
    funnel.append(item);
  }
  stats.append(funnel, el('p', 'Каждый этап учитывает попытку один раз. Этапы пересекаются: после ошибки студент может успешно отправить отклик. Принятие подтверждается сервером; сбой запроса также может означать потерю подтверждения уже принятого отклика. Отклики без попытки не входят в эту воронку.'));
  stats.append(el('h3', 'Затруднения по полям'));
  stats.append(el('p', `Всего посещений: ${analytics.views}, начатых заполнений: ${analytics.starts}. Для каждого типа затруднения попытка учитывается один раз, включая попытки без изменений и с принятым откликом.`));
  const issues = el('div');
  issues.className = 'field-issues';
  for (const field of analytics.fieldIssues) {
    const item = el('article');
    item.className = 'field-issue-card';
    item.append(el('h4', field.label));
    const breakdown = el('dl');
    for (const [key, caption] of Object.entries({ invalidFormat: 'Неверный формат или не выбран вариант', requiredMissing: 'Обязательное поле не заполнено', searchEmpty: 'Поиск не дал результатов', catalogError: 'Ошибка загрузки справочника' })) {
      const count = field[key];
      const percent = analytics.views ? Math.round(count / analytics.views * 100) : 0;
      const row = el('div');
      row.className = `issue-row${count ? ' has-issues' : ''}`;
      const value = el('dd');
      const fraction = el('span');
      fraction.append(el('strong', String(count)), el('span', ` из ${analytics.views}`));
      value.append(fraction, el('span', `${percent}%`));
      const bar = el('span');
      bar.className = 'issue-bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = el('span');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      value.append(bar);
      row.append(el('dt', caption), value);
      breakdown.append(row);
    }
    item.append(breakdown);
    issues.append(item);
  }
  stats.append(issues);
  stats.append(el('h3', 'Последние активные поля'));
  stats.append(el('p', 'Последнее активное поле показывает место остановки, а не установленную причину ухода.'));
  if (!analytics.lastActiveFields.length) stats.append(el('p', 'Незавершённых заполнений нет.'));
  for (const field of analytics.lastActiveFields) stats.append(el('p', `${field.label ?? 'Поле не определено'} — ${new Date(field.lastActiveAt).toLocaleString('ru-RU')} · Попытка ${field.attemptId}`));
  const replies = el('section');
  replies.setAttribute('aria-label', `Отклики (${responses.count})`);
  replies.append(el('h2', `Отклики (${responses.count})`));
  if (!responses.count) replies.append(el('p', 'Пока нет откликов. Поделитесь ссылкой на форму.'));
  for (const [index, response] of /** @type {FormResponse[]} */ (responses.responses).entries()) {
    const item = el('article');
    item.className = 'response-card';
    item.append(el('h3', `Отклик ${index + 1} · ${new Date(response.submittedAt).toLocaleString('ru-RU')}`));
    const answers = el('dl');
    for (const field of form.fields) answers.append(el('dt', field.label), el('dd', answer(response.answers[field.id])));
    item.append(answers);
    replies.append(item);
  }
  results.append(stats, replies);
}

async function navigate() {
  content.replaceChildren();
  await run(async () => {
    const id = location.hash.slice(1);
    if (!id) await list();
    else if (id === 'new') editor(null);
    else {
      const form = /** @type {Form} */ (await api(`/api/forms/${encodeURIComponent(id)}`));
      if (form.status === 'draft') editor(form);
      else await publishedView(form);
    }
    message.textContent = '';
  }, 'Загрузка…');
}
content.addEventListener('click', event => {
  if (busy && event.target instanceof Element && event.target.closest('a')) event.preventDefault();
});
window.addEventListener('hashchange', () => { if (!busy) void navigate(); else pendingNavigation = true; });
void navigate();
