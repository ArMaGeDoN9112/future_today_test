/** @typedef {import('../server.js').Form} Form */
/** @typedef {import('../catalogs.js').CatalogEntry} Entry */
const content = /** @type {HTMLDivElement} */ (document.querySelector('#content'));
const message = /** @type {HTMLDivElement} */ (document.querySelector('#message'));
const error = /** @type {HTMLParagraphElement} */ (document.querySelector('#error'));
const path = location.pathname;
/** @type {Record<string, string>} */
const catalogs = { city: 'cities', university: 'universities', study_direction: 'study-directions' };
const levels = { bachelor: 'Бакалавриат', master: 'Магистратура', specialist: 'Специалитет' };
const navigation = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
/** @type {{id?: string, completed?: boolean, started?: boolean}} */
let attempt = ['reload', 'back_forward'].includes(navigation?.type ?? '') ? history.state?.attempt ?? {} : {};
let events = Promise.resolve();
let lastActivity = 0;

/** @param {'change' | 'focus' | 'activity'} type @param {string} [fieldId] */
function track(type, fieldId) {
  if (!attempt.id || attempt.completed || (type !== 'change' && !attempt.started)) return;
  if (type === 'change') { attempt.started = true; remember(); }
  lastActivity = Date.now();
  const url = `${path}/attempts/${encodeURIComponent(attempt.id)}/events`;
  events = events.then(async () => { await api(url, { type, ...(fieldId === undefined ? {} : { fieldId }) }); }).catch(showError);
}

for (const event of ['pointerdown', 'keydown']) {
  document.addEventListener(event, () => {
    if (Date.now() - lastActivity >= 15000) track('activity');
  });
}

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] */
function el(tag, text = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/** @param {string} url @param {unknown} [body] */
async function api(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new Error('Не удалось связаться с сервером. Проверьте соединение и повторите действие.'); });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? 'Приём завершён. Отправка отклика недоступна.' : data.error);
  return data;
}

function remember() { history.replaceState({ attempt }, ''); }
/** @param {unknown} cause */
function showError(cause) {
  error.textContent = cause instanceof Error ? cause.message : 'Не удалось выполнить действие. Повторите попытку.';
  error.hidden = false;
}

function success() {
  error.hidden = true;
  content.replaceChildren(el('h1', 'Отклик отправлен'), el('p', 'Спасибо! Ваш отклик принят.'));
  const again = el('button', 'Заполнить ещё раз');
  again.onclick = () => { attempt = {}; remember(); void load(); };
  content.append(again);
  message.textContent = '';
}

/** @param {Entry} entry */
function entryLabel(entry) {
  return [entry.code, entry.name, entry.region, entry.level && !entry.course && levels[entry.level]].filter(Boolean).join(' · ');
}

/** @param {Form} form @param {Entry[]} courses */
function render(form, courses) {
  content.replaceChildren(el('h1', form.title));
  document.title = `${form.title} · Форма отклика`;
  message.textContent = '';
  if (form.status === 'closed') { content.append(el('h2', 'Приём завершён')); return; }
  if (attempt.completed) { success(); return; }
  const panel = el('form');
  panel.noValidate = true;
  panel.autocomplete = 'off';
  panel.className = 'card';
  panel.append(el('p', 'Заполните форму, чтобы отправить отклик. Регистрация не нужна.'));
  /** @type {{field: import('../server.js').Field, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLFieldSetElement, feedback: HTMLParagraphElement, search?: HTMLInputElement, selected?: Entry}[]} */
  const controls = [];
  function updateCourses() {
    const selectedLevels = controls.filter(item => item.field.type === 'study_direction' && item.selected).map(item => item.selected?.level);
    for (const item of controls.filter(item => item.field.type === 'study_level_course')) {
      const control = /** @type {HTMLSelectElement} */ (item.control);
      const value = control.value;
      control.replaceChildren(new Option('Выберите вариант', ''), ...courses
        .filter(course => selectedLevels.every(level => level === course.level))
        .map(course => new Option(course.name, course.id)));
      control.value = [...control.options].some(option => option.value === value) ? value : '';
    }
  }
  for (const field of form.fields) {
    const group = el('div');
    group.className = 'field';
    const multiple = field.type === 'multiple_choice';
    const caption = el(multiple ? 'legend' : 'label', `${field.label} · ${field.required ? 'Обязательное' : 'Необязательное'}`);
    const catalog = catalogs[field.type];
    const control = multiple ? el('fieldset') : field.type === 'long_text' ? el('textarea') : field.type === 'single_choice' || field.type === 'study_level_course' || catalog ? el('select') : el('input');
    if (control instanceof HTMLInputElement) control.type = field.type === 'email' ? 'email' : 'text';
    if (control instanceof HTMLSelectElement) {
      control.append(new Option('Выберите вариант', ''));
      for (const option of field.options ?? []) control.append(new Option(option, option));
    }
    control.id = crypto.randomUUID();
    if (!(control instanceof HTMLFieldSetElement)) control.required = field.required;
    if (caption instanceof HTMLLabelElement) caption.htmlFor = control.id;
    const feedback = el('p');
    feedback.id = `${control.id}-error`;
    feedback.className = 'field-error';
    control.setAttribute('aria-describedby', feedback.id);
    /** @type {typeof controls[number]} */
    const item = { field, control, feedback };
    if (control instanceof HTMLFieldSetElement) {
      control.append(caption);
      for (const option of field.options ?? []) {
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.value = option;
        checkbox.setAttribute('aria-describedby', feedback.id);
        const optionLabel = el('label');
        optionLabel.className = 'checkbox-option';
        optionLabel.append(checkbox, el('span', option));
        control.append(optionLabel);
      }
      group.append(control, feedback);
    } else group.append(caption, control, feedback);
    if (catalog) {
      const search = el('input');
      search.type = 'search';
      search.id = `${control.id}-search`;
      search.autocomplete = 'off';
      search.setAttribute('aria-describedby', feedback.id);
      if (caption instanceof HTMLLabelElement) caption.htmlFor = search.id;
      item.search = search;
      const choices = /** @type {HTMLSelectElement} */ (control);
      choices.size = 4;
      choices.hidden = true;
      choices.setAttribute('aria-label', `Варианты: ${field.label}`);
      const hint = el('p', 'Введите название и выберите вариант из списка.');
      hint.className = 'hint';
      hint.setAttribute('role', 'status');
      group.insertBefore(search, control);
      group.insertBefore(hint, feedback);
      let revision = 0;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      /** @type {Entry[]} */
      let entries = [];
      search.oninput = () => {
        clearTimeout(timer);
        const current = ++revision;
        item.selected = undefined;
        entries = [];
        choices.hidden = true;
        choices.replaceChildren(new Option('Выберите вариант', ''));
        updateCourses();
        if (!search.value.trim()) { hint.textContent = 'Введите название и выберите вариант из списка.'; return; }
        hint.textContent = 'Поиск…';
        timer = setTimeout(async () => {
          try {
            const result = await api(`/api/catalogs/${catalog}?q=${encodeURIComponent(search.value)}`);
            if (current !== revision) return;
            entries = result.items;
            // shortcut: первые 50 совпадений; если уточнения поиска недостаточно, добавить страницы результатов.
            choices.append(...entries.slice(0, 50).map(entry => new Option(entryLabel(entry), entry.id)));
            choices.hidden = entries.length === 0;
            hint.textContent = !entries.length ? 'Нет нужного варианта? Свяжитесь с организатором' :
              entries.length > 50 ? 'Показаны первые 50 вариантов. Уточните поиск.' : 'Выберите вариант из списка.';
          } catch (cause) {
            if (current === revision) hint.textContent = 'Не удалось загрузить варианты. Измените запрос, чтобы повторить поиск.';
          }
        }, 200);
      };
      let navigating = false;
      const choose = () => {
        item.selected = entries.find(entry => entry.id === choices.value);
        if (item.selected) {
          search.value = entryLabel(item.selected);
          hint.textContent = '';
          if (!navigating) {
            choices.hidden = true;
            search.focus();
          }
        }
        updateCourses();
      };
      choices.onchange = choose;
      choices.onclick = choose;
      choices.onkeydown = event => {
        navigating = event.key !== 'Enter';
        if (!navigating) { event.preventDefault(); choose(); }
      };
      choices.onkeyup = () => { navigating = false; };
      choices.onpointerdown = () => { navigating = false; };
    }
    panel.append(group);
    controls.push(item);
  }
  updateCourses();
  panel.addEventListener('input', event => {
    const item = controls.find(item => event.target instanceof Node && item.control.contains(event.target) || item.search === event.target);
    if (item) track('change', item.field.id);
  });
  panel.addEventListener('focusin', event => {
    const item = controls.find(item => event.target instanceof Node && item.control.contains(event.target) || item.search === event.target);
    if (item) track('focus', item.field.id);
  });
  const send = el('button', 'Отправить отклик');
  send.className = 'primary';
  send.type = 'submit';
  panel.append(send);
  content.append(panel);
  panel.onsubmit = async event => {
    event.preventDefault();
    if (send.disabled) return;
    error.hidden = true;
    /** @type {Record<string, string | string[]>} */
    const answers = Object.create(null);
    let invalid = false;
    for (const { field, control, feedback, search } of controls) {
      if (control instanceof HTMLFieldSetElement) {
        const selected = [...control.querySelectorAll('input:checked')].map(input => /** @type {HTMLInputElement} */ (input).value);
        feedback.textContent = field.required && !selected.length ? 'Выберите хотя бы один вариант.' : '';
        control.setAttribute('aria-invalid', String(Boolean(feedback.textContent)));
        if (feedback.textContent && !invalid) { control.querySelector('input')?.focus(); invalid = true; }
        if (selected.length) answers[field.id] = selected;
        continue;
      }
      const value = control.value;
      feedback.textContent = search && !value && (field.required || search.value.trim()) ? 'Выберите значение из справочника.' :
        field.required && !value.trim() ? 'Заполните обязательное поле.' :
        value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'Введите корректный email.' : '';
      control.setAttribute('aria-invalid', String(Boolean(feedback.textContent)));
      search?.setAttribute('aria-invalid', String(Boolean(feedback.textContent)));
      if (feedback.textContent && !invalid) { (search ?? control).focus(); invalid = true; }
      if (value.trim()) answers[field.id] = value;
    }
    if (invalid) return;
    send.disabled = true;
    message.textContent = 'Отправка отклика…';
    try {
      await events;
      await api(`${path}/responses`, { answers, attemptId: attempt.id });
      attempt.completed = true;
      remember();
      success();
    } catch (cause) { showError(cause); message.textContent = ''; }
    finally { send.disabled = false; }
  };
}

async function load() {
  error.hidden = true;
  content.replaceChildren();
  message.textContent = 'Загрузка…';
  try {
    const form = /** @type {Form} */ (await api(path));
    if (form.status === 'published' && !attempt.completed) {
      const visit = await api(`${path}/attempts`, attempt.id ? { attemptId: attempt.id } : {});
      attempt.id = visit.id;
      attempt.started = Boolean(visit.startedAt);
      remember();
    }
    const courses = form.status === 'published' && !attempt.completed && form.fields.some(field => field.type === 'study_level_course') ?
      (await api('/api/catalogs/study-courses')).items : [];
    render(form, courses);
  } catch (cause) {
    showError(cause);
    message.textContent = '';
    const retry = el('button', 'Повторить загрузку');
    retry.onclick = () => { void load(); };
    content.append(retry);
  }
}
void load();
