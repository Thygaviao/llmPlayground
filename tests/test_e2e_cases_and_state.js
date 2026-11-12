const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

console.log("=================================================================");
console.log("СКВОЗНОЕ ТЕСТИРОВАНИЕ ВСЕХ МОДУЛЕЙ И КЕЙСОВ ПЕРЕД РЕЛИЗОМ");
console.log("=================================================================\n");

const html = fs.readFileSync("index.html", "utf-8");
const match = html.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi);
const scriptCode = match[1].replace(/<script[^>]*>/, "").replace(/<\/script>/, "");

function createTestEnvironment(initialLocalStorage = {}, isOffline = false, hostname = '') {
  const store = new Map(Object.entries(initialLocalStorage));
  const mockElements = new Map();

  function getMockEl(id) {
    if (!mockElements.has(id)) {
      mockElements.set(id, {
        id: id,
        value: '',
        checked: false,
        disabled: false,
        classList: {
          classes: new Set(),
          add: function(...cls) { cls.forEach(c => this.classes.add(c)); },
          remove: function(...cls) { cls.forEach(c => this.classes.delete(c)); },
          contains: function(c) { return this.classes.has(c); }
        },
        style: {},
        innerHTML: '',
        innerText: '',
        addEventListener: () => {},
        removeEventListener: () => {},
        scrollIntoView: function() {},
        click: function() { this.clicked = true; },
        focus: function() { this.focused = true; },
        querySelector: function(sel) { return null; },
        querySelectorAll: function(sel) { return []; },
        getContext: function() {
          return {
            clearRect: () => {}, fillRect: () => {}, strokeRect: () => {},
            beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
            stroke: () => {}, fill: () => {}, arc: () => {}, ellipse: () => {}, setLineDash: () => {},
            bezierCurveTo: () => {}, quadraticCurveTo: () => {},
            fillText: () => {}, strokeText: () => {}, measureText: () => ({ width: 10 }),
            createLinearGradient: () => ({ addColorStop: () => {} }),
            createRadialGradient: () => ({ addColorStop: () => {} })
          };
        },
        getAttribute: function(attr) { return this[attr] || null; },
        setAttribute: function(attr, val) { this[attr] = val; }
      });
    }
    return mockElements.get(id);
  }

  const domContentLoadedListeners = [];
  const context = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      _store: store
    },
    document: {
      getElementById: (id) => getMockEl(id),
      querySelectorAll: (sel) => [],
      querySelector: (sel) => null,
      createElement: (tag) => getMockEl('elem_' + tag + '_' + Math.random().toString(36).substring(2, 6)),
      body: { appendChild: () => {}, removeChild: () => {} }
    },
    window: {
      location: { href: '', protocol: isOffline ? 'file:' : (hostname ? 'https:' : 'http:'), hostname: hostname },
      addEventListener: (evt, fn) => {
        if (evt === 'DOMContentLoaded') domContentLoadedListeners.push(fn);
      },
      removeEventListener: () => {},
      scrollTo: (x, y) => { context._scrolledY = y; }
    },
    location: { protocol: isOffline ? 'file:' : (hostname ? 'https:' : 'http:'), hostname: hostname },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob://test' },
    fetch: async (url, opts) => {
      if (isOffline) throw new Error("Network offline fallback");
      if (typeof url === 'string') {
        if (url.includes('/api/cases')) return { ok: true, json: async () => vm.runInContext('EMBEDDED_CASES', context) };
        if (url.includes('/api/cv-cases')) return { ok: true, json: async () => vm.runInContext('EMBEDDED_CV_CASES', context) };
        if (url.includes('/api/nlp-cases')) return { ok: true, json: async () => vm.runInContext('EMBEDDED_NLP_CASES', context) };
        if (url.includes('/api/custom-annotations')) return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
  };

  vm.createContext(context);
  vm.runInContext(scriptCode, context);
  async function triggerDOMContentLoaded() {
    for (const fn of domContentLoadedListeners) {
      await fn();
    }
  }
  return { context, getMockEl, store, triggerDOMContentLoaded };
}

// -------------------------------------------------------------
// 1. ПРОВЕРКА ВСЕХ 12 КЕЙСОВ LLM
// -------------------------------------------------------------
console.log("--- 1. Проверка всех 12 LLM обучающих кейсов ---");
const { context: ctx1, getMockEl: el1 } = createTestEnvironment();
const allLlmCases = vm.runInContext('EMBEDDED_CASES', ctx1);
assert.strictEqual(allLlmCases.length, 12, "Должно быть ровно 12 обучающих кейсов LLM");

allLlmCases.forEach((c, idx) => {
  assert(c.id, `Кейс #${idx} должен иметь id`);
  assert(c.title, `Кейс #${c.id} должен иметь название`);
  assert(c.category, `Кейс #${c.id} должен иметь категорию`);
  assert(c.prompt, `Кейс #${c.id} должен иметь промпт`);
  assert(c.model_response || (c.model_response_a && c.model_response_b), `Кейс #${c.id} должен иметь ответ(ы) модели`);
  assert(c.gold_standard, `Кейс #${c.id} должен иметь gold_standard`);

  // Проверка структуры gold_standard
  const gs = c.gold_standard;
  if (c.type === 'side_by_side') {
    assert(gs.preferred, `SBS кейс ${c.id} должен содержать preferred в эталоне`);
    assert(c.model_response_b, `SBS кейс ${c.id} должен содержать model_response_b`);
  } else {
    assert(gs.scores, `Single кейс ${c.id} должен содержать scores в эталоне`);
    ['instruction_following', 'factuality', 'completeness', 'coherence_literacy'].forEach(crit => {
      assert(typeof gs.scores[crit] === 'number', `Критерий ${crit} в кейсе ${c.id} должен быть числом`);
    });
  }
});

// Инициализируем cases
vm.runInContext('cases = EMBEDDED_CASES;', ctx1);
allLlmCases.forEach((c, idx) => {
  ctx1.loadCase(idx, false);
  const curCase = vm.runInContext('cases[currentCaseIndex]', ctx1);
  assert.strictEqual(curCase.id, c.id, `UI должен загрузить кейс ${c.id}`);

  // Проверяем, что по умолчанию оценки НЕ предвыбраны (все null)
  if (c.type !== 'side_by_side') {
    const userScores = vm.runInContext('currentScores', ctx1);
    const hasPreselected = Object.values(userScores).some(v => v !== null);
    assert(!hasPreselected, `Кейс ${c.id} не должен иметь предвыбранных оценок 3/5 или 5/5`);
  }
});
console.log("✓ Все 12 кейсов LLM валидны: полная структура, эталоны, отсутствие предвыбранных оценок.");

// -------------------------------------------------------------
// 2. ПРОВЕРКА ВСЕХ 3 КЕЙСОВ NLP
// -------------------------------------------------------------
console.log("\n--- 2. Проверка всех 3 NLP обучающих кейсов ---");
const allNlpCases = vm.runInContext('EMBEDDED_NLP_CASES', ctx1);
assert.strictEqual(allNlpCases.length, 3, "Должно быть ровно 3 NLP кейса");

allNlpCases.forEach((c, idx) => {
  assert(c.id, `NLP кейс #${idx} должен иметь id`);
  assert(c.title, `NLP кейс #${c.id} должен иметь title`);
  assert(c.instruction, `NLP кейс #${c.id} должен иметь инструкцию`);
  ctx1.loadNlpCase(idx, false);
  const curNlp = vm.runInContext('nlpCases[currentNlpIndex]', ctx1);
  assert.strictEqual(curNlp.id, c.id);
});

// Тестирование NER разметки (NLP-1)
ctx1.loadNlpCase(0, false);
const nlpCase1 = vm.runInContext('nlpCases[0]', ctx1);
// Заполняем эталонными тегами: DATE, ORG, PER, MONEY, NONE
nlpCase1.tokens.forEach(t => {
  ctx1.setActiveNerTag(nlpCase1.ground_truth[t.id]);
  ctx1.tagNerToken(t.id);
});
ctx1.verifyNerTask();
const nlpEval1 = vm.runInContext('nlpEvaluations["nlp_1"]', ctx1);
assert(nlpEval1, "NLP-1 должен вернуть результат проверки");
assert.strictEqual(nlpEval1.score, 100, `NLP-1 эталонная разметка должна набрать 100%, получено: ${nlpEval1.score}%`);
console.log(`✓ Кейс NLP-1 (NER): проверен, эталонный балл = ${nlpEval1.score}%`);

// Тестирование анализа тональности (NLP-2)
ctx1.loadNlpCase(1, false);
ctx1.document.querySelector = (sel) => {
  if (sel.includes('nlp_sentiment_radio')) return { value: 'Негативная' };
  return null;
};
el1('nlpSarcasmCheck').checked = true;
ctx1.verifySentimentTask();
const nlpEval2 = vm.runInContext('nlpEvaluations["nlp_2"]', ctx1);
assert.strictEqual(nlpEval2.score, 100, "NLP-2 сарказм+негатив должен дать 100%");
console.log("✓ Кейс NLP-2 (Sentiment & Sarcasm): проверен, эталонный балл = 100%");

// Тестирование ранжирования поиска (NLP-3)
ctx1.loadNlpCase(2, false);
ctx1.document.querySelector = (sel) => {
  if (sel.includes('nlp_relevance_radio')) return { value: 'Нерелевантно' };
  return null;
};
ctx1.verifyRelevanceTask();
const nlpEval3 = vm.runInContext('nlpEvaluations["nlp_3"]', ctx1);
assert.strictEqual(nlpEval3.score, 100, "NLP-3 ранжирование должно быть 100%");
console.log(`✓ Кейс NLP-3 (Search Relevance): проверен, эталонный балл = ${nlpEval3.score}%`);

// -------------------------------------------------------------
// 3. ПРОВЕРКА ВСЕХ 3 КЕЙСОВ CV
// -------------------------------------------------------------
console.log("\n--- 3. Проверка всех 3 CV обучающих кейсов ---");
const allCvCases = vm.runInContext('EMBEDDED_CV_CASES', ctx1);
assert.strictEqual(allCvCases.length, 3, "Должно быть ровно 3 CV кейса");

// CV-1: Камни
ctx1.loadCvCase(0);
vm.runInContext(`cvUserBoxes = [
  { label: 'Камень', x: 75, y: 140, w: 125, h: 95 },
  { label: 'Камень', x: 280, y: 80, w: 85, h: 70 },
  { label: 'Камень', x: 440, y: 210, w: 110, h: 80 },
  { label: 'Камень', x: 220, y: 260, w: 55, h: 45 }
];`, ctx1);
ctx1.verifyCvAnnotation();
const cvEval1 = vm.runInContext('cvEvaluations["cv_1"]', ctx1);
assert.strictEqual(cvEval1.found, 4);
assert.strictEqual(cvEval1.classErrors, 0);
assert(cvEval1.avgIou >= 90);
console.log(`✓ Кейс CV-1 (Камни): найдено ${cvEval1.found}/4, IoU = ${cvEval1.avgIou}%`);

// CV-2: Дефектоскопия (проверка верных классов)
ctx1.loadCvCase(1);
vm.runInContext(`cvUserBoxes = [
  { label: 'Трещина', x: 130, y: 90, w: 140, h: 60 },
  { label: 'Скол', x: 390, y: 120, w: 70, h: 65 },
  { label: 'Пятно', x: 260, y: 250, w: 95, h: 80 }
];`, ctx1);
ctx1.verifyCvAnnotation();
const cvEval2 = vm.runInContext('cvEvaluations["cv_2"]', ctx1);
assert.strictEqual(cvEval2.found, 3);
assert.strictEqual(cvEval2.classErrors, 0);
console.log(`✓ Кейс CV-2 (Дефектоскопия - верные классы): найдено ${cvEval2.found}/3, ошибок класса: 0`);

// CV-2: Дефектоскопия (проверка фиксации ошибки класса)
vm.runInContext(`cvUserBoxes = [
  { label: 'Трещина', x: 130, y: 90, w: 140, h: 60 },
  { label: 'Трещина', x: 390, y: 120, w: 70, h: 65 },
  { label: 'Трещина', x: 260, y: 250, w: 95, h: 80 }
];`, ctx1);
ctx1.verifyCvAnnotation();
const cvEval2Mismatch = vm.runInContext('cvEvaluations["cv_2"]', ctx1);
assert.strictEqual(cvEval2Mismatch.classErrors, 2, "Должно быть ровно 2 ошибки класса");
assert.strictEqual(cvEval2Mismatch.found, 1, "Только 1 объект должен быть зачтен");
console.log(`✓ Кейс CV-2 (Дефектоскопия - перепутан класс): корректно обнаружено ${cvEval2Mismatch.classErrors} ошибки класса`);

// CV-3: Автопилот (Пешеход и Знак)
ctx1.loadCvCase(2);
vm.runInContext(`cvUserBoxes = [
  { label: 'Пешеход', x: 160, y: 130, w: 65, h: 190 },
  { label: 'Знак', x: 420, y: 70, w: 75, h: 85 }
];`, ctx1);
ctx1.verifyCvAnnotation();
const cvEval3 = vm.runInContext('cvEvaluations["cv_3"]', ctx1);
assert.strictEqual(cvEval3.found, 2);
assert.strictEqual(cvEval3.classErrors, 0);
console.log(`✓ Кейс CV-3 (Автопилот): найдено ${cvEval3.found}/2 объектов`);

// -------------------------------------------------------------
// 4. ПРОВЕРКА ПЕСОЧНИЦЫ SFT И DPO
// -------------------------------------------------------------
console.log("\n--- 4. Проверка Песочницы (SFT / DPO) ---");
// А. Режим SFT
ctx1.setPlaygroundMode('single');
el1('pgPrompt').value = 'Напиши SQL-запрос для выборки активных пользователей';
el1('pgResponseA').value = 'SELECT * FROM users WHERE is_active = 1;';
['instruction_following', 'factuality', 'completeness', 'coherence_literacy'].forEach(crit => {
  ctx1.setPgScore(crit, 5, 'single');
});
el1('pgReasoning').value = 'Точный, лаконичный и синтаксически корректный SQL запрос.';

let savedPayload = null;
ctx1.fetch = async (url, opts) => {
  if (opts && opts.body) {
    savedPayload = JSON.parse(opts.body);
  }
  if (url.includes('/api/custom-annotations') && (!opts || opts.method !== 'POST')) {
    return { ok: true, json: async () => [] };
  }
  return { ok: true, json: async () => ({ id: 999, status: 'ok' }) };
};

ctx1.saveCustomAnnotation();
assert(savedPayload, "SFT разметка должна быть отправлена");
assert.strictEqual(savedPayload.mode, 'single');
assert.strictEqual(savedPayload.scores.instruction_following, 5);
assert.strictEqual(savedPayload.reasoning, 'Точный, лаконичный и синтаксически корректный SQL запрос.');
console.log("✓ Песочница SFT: успешная валидация и сохранение с 4 критериями");

// Б. Режим DPO
ctx1.setPlaygroundMode('sbs');
el1('pgPrompt').value = 'Что быстрее: C++ или Python?';
el1('pgResponseSbsA').value = 'C++ быстрее, так как компилируется в машинный код.';
el1('pgResponseSbsB').value = 'Python быстрее, так как у него меньше строчек кода.';
ctx1.selectPgSbsPref('model_a_much');
['instruction_following', 'factuality', 'completeness', 'coherence_literacy'].forEach(crit => {
  ctx1.setPgScore(crit, 5, 'sbs_a');
  ctx1.setPgScore(crit, 1, 'sbs_b');
});
el1('pgReasoning').value = 'Модель А дала верное объяснение с точки зрения архитектуры исполнения, модель B продемонстрировала грубую фактологическую ошибку.';

savedPayload = null;
ctx1.fetch = async (url, opts) => {
  if (opts && opts.body) {
    savedPayload = JSON.parse(opts.body);
  }
  if (url.includes('/api/custom-annotations') && (!opts || opts.method !== 'POST')) {
    return { ok: true, json: async () => [] };
  }
  return { ok: true, json: async () => ({ id: 1000, status: 'ok' }) };
};
ctx1.saveCustomAnnotation();
assert(savedPayload, "DPO разметка должна быть отправлена");
assert.strictEqual(savedPayload.mode, 'sbs');
assert.strictEqual(savedPayload.preferred, 'model_a_much');
assert.deepStrictEqual(savedPayload.scores.scores_a, { instruction_following: 5, factuality: 5, completeness: 5, coherence_literacy: 5 });
assert.deepStrictEqual(savedPayload.scores.scores_b, { instruction_following: 1, factuality: 1, completeness: 1, coherence_literacy: 1 });
console.log("✓ Песочница DPO: раздельные шкалы A (5/5/5/5) и B (1/1/1/1), выбор победителя и обоснование");

// -------------------------------------------------------------
// 5. ПРОВЕРКА СОХРАНЕНИЯ СОСТОЯНИЯ ПОСЛЕ ПЕРЕЗАГРУЗКИ (LOCALSTORAGE)
// -------------------------------------------------------------
console.log("\n--- 5. Проверка сохранения состояния после перезагрузки страницы ---");
// Сохраняем состояние пользователя в localStorage
const savedState = {
  'trainer_active_mode': 'cv',
  'trainer_case_cv_idx': '2',
  'trainer_username': 'Асессор-Эксперт',
  'trainer_scroll_pos': '350'
};

// Симулируем "перезагрузку" страницы: создаём чистое окружение с сохранённым localStorage
const { context: ctxReload, getMockEl: elReload, triggerDOMContentLoaded: domReadyReload } = createTestEnvironment(savedState);
(async () => {
  await domReadyReload();

  // Проверяем восстановление активного экрана
  const restoredMode = vm.runInContext('currentAppMode', ctxReload);
  assert.strictEqual(restoredMode, 'cv', "После перезагрузки должен восстановиться раздел CV");
  console.log(`✓ Восстановлен активный раздел: "${restoredMode}"`);

  // Проверяем восстановление выбранного CV кейса
  const restoredCvIdx = vm.runInContext('currentCvIndex', ctxReload);
  assert.strictEqual(restoredCvIdx, 2, "После перезагрузки должен открыться 3-й кейс CV (индекс 2)");
  console.log(`✓ Восстановлен активный кейс: CV-${restoredCvIdx + 1}`);

  // Проверяем восстановление имени пользователя
  const restoredUsername = elReload('usernameInput').value;
  assert.strictEqual(restoredUsername, 'Асессор-Эксперт');
  console.log(`✓ Восстановлено имя пользователя: "${restoredUsername}"`);

  // 5.2. Сценарий пользователя: «размечаю камни -> перезагрузка -> остаюсь на камнях со своими рамками»
  const rocksState = {
    'trainer_active_mode': 'cv',
    'trainer_case_cv_idx': '0', // CV-1: Камни на грунте
    'trainer_cv_boxes': JSON.stringify({
      'cv_1': [
        { id: 'usr_rock_1', label: 'Камень', x: 100, y: 150, w: 60, h: 45 },
        { id: 'usr_rock_2', label: 'Камень', x: 300, y: 220, w: 90, h: 65 }
      ]
    }),
    'trainer_cv_tool_cv_1': 'Камень',
    'trainer_scroll_pos': '420'
  };

  const { context: ctxRocks, getMockEl: elRocks, triggerDOMContentLoaded: domReadyRocks } = createTestEnvironment(rocksState);
  await domReadyRocks();

  const rocksMode = vm.runInContext('currentAppMode', ctxRocks);
  const rocksCvIdx = vm.runInContext('currentCvIndex', ctxRocks);
  const rocksUserBoxes = vm.runInContext('cvUserBoxes', ctxRocks);
  const rocksActiveTool = vm.runInContext('cvActiveTool', ctxRocks);
  const rocksCaseTitle = elRocks('cvCaseTitle').innerText;
  assert.strictEqual(rocksMode, 'cv', "Режим должен остаться 'cv'");
  assert.strictEqual(rocksCvIdx, 0, "Кейс должен остаться 0 (Камни на грунте)");
  assert(rocksCaseTitle.toLowerCase().includes('камней'), "Заголовок кейса должен содержать 'камней'");
  assert.strictEqual(rocksUserBoxes.length, 2, "Нарисованные рамки камней должны сохраниться и восстановиться");
  assert.strictEqual(rocksUserBoxes[0].label, 'Камень');
  assert.strictEqual(rocksActiveTool, 'Камень');
  console.log("✓ Сценарий «Разметка камней»: пользователь остаётся на камнях со всеми нарисованными рамками после обновления страницы");

  // -------------------------------------------------------------
  // 6. ПРОВЕРКА РАБОТЫ АВТОНОМНОЙ СБОРКИ (ОФЛАЙН / БЕЗ LOCALHOST)
  // -------------------------------------------------------------
  console.log("\n--- 6. Проверка автономной сборки (file:// / оффлайн без сервера) ---");
  const { context: ctxOffline, triggerDOMContentLoaded: domReadyOffline } = createTestEnvironment({}, true); // isOffline = true
  await domReadyOffline();

  // Проверяем, что кейсы подгрузились из встроенных структур (fallback)
  const offlineLlmCount = vm.runInContext('cases.length', ctxOffline);
  const offlineCvCount = vm.runInContext('cvCases.length', ctxOffline);
  const offlineNlpCount = vm.runInContext('nlpCases.length', ctxOffline);
  assert.strictEqual(offlineLlmCount, 12, "Оффлайн сборка должна содержать 12 встроенных LLM кейсов");
  assert.strictEqual(offlineCvCount, 3, "Оффлайн сборка должна содержать 3 встроенных CV кейса");
  assert.strictEqual(offlineNlpCount, 3, "Оффлайн сборка должна содержать 3 встроенных NLP кейса");
  console.log(`✓ Оффлайн fallback: 12 LLM, 3 CV, 3 NLP кейсов доступны без подключения к бэкенду`);

  // Проверяем клиентский экспорт JSONL
  ctxOffline.exportJSONL();
  console.log("✓ Клиентский экспорт в формате JSONL выполняется локально через Blob");

  // -------------------------------------------------------------
  // 7. ПРОВЕРКА РАЗВЕРТЫВАНИЯ НА GITHUB PAGES (*.github.io)
  // -------------------------------------------------------------
  console.log("\n--- 7. Проверка развертывания на GitHub Pages (*.github.io) ---");
  const { context: ctxPages, triggerDOMContentLoaded: domReadyPages, getMockEl: elPages } = createTestEnvironment({}, false, 'eval-trainer.github.io');
  await domReadyPages();

  const isStatic = vm.runInContext('checkIsStaticHost()', ctxPages);
  assert.strictEqual(isStatic, true, "Хост *.github.io должен определяться как статический хостинг");

  const pagesLlmCount = vm.runInContext('cases.length', ctxPages);
  const pagesCvCount = vm.runInContext('cvCases.length', ctxPages);
  const pagesNlpCount = vm.runInContext('nlpCases.length', ctxPages);
  assert.strictEqual(pagesLlmCount, 12, "GitHub Pages сборка содержит 12 LLM кейсов");
  assert.strictEqual(pagesCvCount, 3, "GitHub Pages сборка содержит 3 CV кейса");
  assert.strictEqual(pagesNlpCount, 3, "GitHub Pages сборка содержит 3 NLP кейса");

  const badgeEl = elPages('staticModeBadge');
  assert(badgeEl.classList.contains('hidden') === false, "Бейдж GitHub Pages должен быть активен");

  // Проверяем клиентский экспорт CSV и JSONL без обращения к бэкенду
  ctxPages.exportCSV();
  ctxPages.exportJSONL();
  console.log("✓ GitHub Pages хостинг: бейдж активен, кейсы загружены, клиентский экспорт CSV/JSONL работает");

  console.log("\n=================================================================");
  console.log(">>> ВСЕ СКВОЗНЫЕ ПРОВЕРКИ УСПЕШНО ПРОЙДЕНЫ! СБОРКА ГОТОВА. <<<");
  console.log("=================================================================");
})();
