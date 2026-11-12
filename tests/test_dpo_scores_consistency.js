const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

console.log("=================================================================");
console.log("ТЕСТ СОГЛАСОВАННОСТИ ОЦЕНОК DPO (ТАБЛИЦА vs ОКНО vs ЭКСПОРТ)");
console.log("=================================================================\n");

const html = fs.readFileSync("index.html", "utf-8");
const match = html.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi);
const scriptCode = match[1].replace(/<script[^>]*>/, "").replace(/<\/script>/, "");

const mockElements = new Map();
function getMockEl(id) {
  if (!mockElements.has(id)) {
    mockElements.set(id, {
      id: id,
      value: '',
      checked: false,
      classList: {
        classes: new Set(),
        add: function(...cls) { cls.forEach(c => this.classes.add(c)); },
        remove: function(...cls) { cls.forEach(c => this.classes.delete(c)); },
        contains: function(c) { return this.classes.has(c); }
      },
      style: {},
      innerHTML: '',
      innerText: '',
      scrollIntoView: function(opts) { this.scrolled = opts; },
      focus: function() { this.focused = true; },
      querySelector: function() { return null; },
      querySelectorAll: function() { return []; },
      getContext: function() {
        return {
          clearRect: () => {}, fillRect: () => {}, strokeRect: () => {},
          beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
          stroke: () => {}, fill: () => {}, arc: () => {}, ellipse: () => {}, setLineDash: () => {},
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

let lastExportedBlob = null;
let lastExportedFilename = null;

const context = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  document: {
    getElementById: (id) => getMockEl(id),
    querySelectorAll: (sel) => [],
    querySelector: (sel) => null,
    createElement: (tag) => {
      const el = getMockEl('created_' + tag + '_' + Math.random().toString(36).substring(2, 7));
      if (tag === 'a') {
        el.click = function() {
          lastExportedFilename = el['download'] || null;
        };
      }
      return el;
    },
    body: { appendChild: () => {}, removeChild: () => {} }
  },
  window: {
    location: { href: '', protocol: 'http:' },
    addEventListener: () => {},
    removeEventListener: () => {}
  },
  location: { protocol: 'file:' }, // test local client-side JSONL generator
  Blob: class {
    constructor(parts, opts) {
      this.parts = parts;
      this.opts = opts;
      lastExportedBlob = parts.join('');
    }
  },
  URL: { createObjectURL: () => 'blob://test-url' },
  fetch: async () => ({ ok: true, json: async () => [] })
};

vm.createContext(context);
vm.runInContext(scriptCode, context);

// Helper to extract 4 criteria scores from modal html
function extractModalLegacyScores(modalHtml) {
  const regex = /<div class="font-bold text-amber-800 text-sm">\s*(\d+)\s*\/\s*5\s*<\/div>/g;
  const scores = [];
  let m;
  while ((m = regex.exec(modalHtml)) !== null) {
    scores.push(parseInt(m[1], 10));
  }
  return scores;
}

// Helper to find a specific row in the table HTML by rowId (e.g. #fixture, #legacy_42)
function findRowById(tbodyHtml, rowId) {
  const rows = tbodyHtml.split(/<\/tr>/i);
  for (const r of rows) {
    if (r.includes(rowId)) return r + '</tr>';
  }
  return null;
}

// Helper to extract table scores string from table cell
function extractTableLegacyScoreStr(rowHtml) {
  const match = rowHtml.match(/<div class="font-mono text-\[11px\] text-amber-900 leading-tight">\s*([0-9\/-]+)/);
  return match ? match[1].trim() : null;
}

console.log("--- 1. Проверка тестовой фикстуры старого формата (#fixture) ---");
const fixture = vm.runInContext('LEGACY_DPO_FIXTURE', context);
const sourceScores = [
  fixture.quality_scores.instruction_following,
  fixture.quality_scores.factuality,
  fixture.quality_scores.completeness,
  fixture.quality_scores.coherence_literacy
];
console.log("Исходные quality_scores фикстуры:", sourceScores.join('/'));

// А. Проверка отсутствия тестовой фикстуры в обычном пользовательском интерфейсе таблицы
context.renderPlaygroundTable();
const tbodyHtml = getMockEl('pgTableBody').innerHTML;
assert(!tbodyHtml.includes('#fixture'), "Строка #fixture НЕ должна присутствовать в обычной пользовательской таблице (убрана к релизу)");
console.log("✓ Строка #fixture успешно скрыта из пользовательской таблицы");

const fixtureScores = vm.runInContext('formatLegacyScores(LEGACY_DPO_FIXTURE.quality_scores)', context);
console.log("Форматированные оценки фикстуры через formatLegacyScores:", fixtureScores);
assert.strictEqual(fixtureScores, sourceScores.join('/'));

// Б. В модальном окне (для автопроверок)
context.viewDatasetItem('fixture_legacy_dpo');
const modalHtml = getMockEl('datasetItemModalContent').innerHTML;
const modalScores = extractModalLegacyScores(modalHtml);
console.log("Оценки в окне просмотра (#fixture):", modalScores.join('/'));
assert.deepStrictEqual(modalScores, sourceScores, `Окно просмотра должно показывать ${sourceScores.join('/')}, но показывает ${modalScores.join('/')}`);
assert(modalHtml.includes('Оценки старого формата — модель не указана'), "Окно просмотра должно содержать плашку 'Оценки старого формата — модель не указана'");
assert(!modalHtml.includes('Оценки Модели A'), "Окно просмотра для старого формата НЕ должно показывать оценки Модели A");
assert(!modalHtml.includes('Оценки Модели B'), "Окно просмотра для старого формата НЕ должно показывать оценки Модели B");

// В. В JSONL-экспорте
context.exportSingleItemJSONL('fixture_legacy_dpo');
assert(lastExportedBlob, "JSONL экспорт должен создать Blob");
const exportObj = JSON.parse(lastExportedBlob.trim());
console.log("Оценки в экспорте JSONL (#fixture):", exportObj.quality_scores);
const exportScores = [
  exportObj.quality_scores.instruction_following,
  exportObj.quality_scores.factuality,
  exportObj.quality_scores.completeness,
  exportObj.quality_scores.coherence_literacy
];
assert.deepStrictEqual(exportScores, sourceScores, `Экспорт должен содержать ${sourceScores.join('/')}`);
assert.strictEqual(exportObj.legacy_notice, 'Оценки старого формата — модель не указана');
assert.strictEqual(exportObj.scores_a, undefined, "В экспорте старой фикстуры не должно быть scores_a");
assert.strictEqual(exportObj.scores_b, undefined, "В экспорте старой фикстуры не должно быть scores_b");

console.log("✓ Фикстура: Оценки formatLegacyScores (" + fixtureScores + ") == Окно (" + modalScores.join('/') + ") == Экспорт (" + exportScores.join('/') + ") == [5, 4, 4, 5] -> ВСЕ СОВПАДАЮТ!\n");

console.log("--- 2. Проверка произвольной старой DPO-записи из БД (quality_scores) ---");
const legacyDbRecord = {
  id: "legacy_42",
  username: "assessor_bob",
  mode: "sbs",
  prompt: "Расскажи про алгоритм Дейкстры",
  source_text: "Теория графов",
  response_a: "Алгоритм Дейкстры находит кратчайшие пути...",
  response_b: "Дейкстра — это язык программирования...",
  preferred: "model_a_much",
  quality_scores: {
    instruction_following: 3,
    factuality: 2,
    completeness: 5,
    coherence_literacy: 4
  },
  scores: {
    instruction_following: 3,
    factuality: 2,
    completeness: 5,
    coherence_literacy: 4
  },
  reasoning: "Старая разметка до разделения критериев A и B.",
  errors: ["factual_error"],
  is_doubt: false,
  created_at: "2024-03-01 12:00:00"
};

vm.runInContext('customDataset.push(' + JSON.stringify(legacyDbRecord) + ');', context);
context.renderPlaygroundTable();

// А. В таблице
const legTbodyHtml = getMockEl('pgTableBody').innerHTML;
const legacyRowHtml = findRowById(legTbodyHtml, '#legacy_42');
assert(legacyRowHtml, "Строка #legacy_42 должна присутствовать в таблице");
const legTableScoreStr = extractTableLegacyScoreStr(legacyRowHtml);
console.log("Оценки в таблице (#legacy_42):", legTableScoreStr);
assert.strictEqual(legTableScoreStr, "3/2/5/4");
assert(legacyRowHtml.includes('Оценки старого формата — модель не указана'));

// Б. В окне просмотра
context.viewDatasetItem('legacy_42');
const legModalHtml = getMockEl('datasetItemModalContent').innerHTML;
const legModalScores = extractModalLegacyScores(legModalHtml);
console.log("Оценки в окне просмотра (#legacy_42):", legModalScores.join('/'));
assert.deepStrictEqual(legModalScores, [3, 2, 5, 4]);
assert(legModalHtml.includes('Оценки старого формата — модель не указана'));

// В. В экспорте
context.exportSingleItemJSONL('legacy_42');
const legExportObj = JSON.parse(lastExportedBlob.trim());
console.log("Оценки в экспорте (#legacy_42):", legExportObj.quality_scores);
const legExportScores = [
  legExportObj.quality_scores.instruction_following,
  legExportObj.quality_scores.factuality,
  legExportObj.quality_scores.completeness,
  legExportObj.quality_scores.coherence_literacy
];
assert.deepStrictEqual(legExportScores, [3, 2, 5, 4]);
assert.strictEqual(legExportObj.legacy_notice, 'Оценки старого формата — модель не указана');
assert.strictEqual(legExportObj.scores_a, undefined);
assert.strictEqual(legExportObj.scores_b, undefined);

console.log("✓ Произвольная старая запись: Таблица (" + legTableScoreStr + ") == Окно (" + legModalScores.join('/') + ") == Экспорт (" + legExportScores.join('/') + ") == [3, 2, 5, 4] -> ВСЕ СОВПАДАЮТ!\n");

console.log("--- 3. Проверка новой DPO-записи (раздельные scores_a и scores_b) ---");
const newDpoRecord = {
  id: "new_101",
  username: "senior_annotator",
  mode: "sbs",
  prompt: "Напиши функцию реверса строки на Python",
  source_text: "",
  response_a: "def rev(s): return s[::-1]",
  response_b: "def rev(s): return ''.join(reversed(s))",
  preferred: "model_a_slightly",
  scores: {
    scores_a: {
      instruction_following: 5,
      factuality: 4,
      completeness: 3,
      coherence_literacy: 5
    },
    scores_b: {
      instruction_following: 4,
      factuality: 3,
      completeness: 5,
      coherence_literacy: 2
    }
  },
  reasoning: "Модель A компактнее, модель B использует генератор.",
  errors: [],
  is_doubt: false,
  created_at: "2026-11-11 12:00:00"
};

vm.runInContext('customDataset.push(' + JSON.stringify(newDpoRecord) + ');', context);
context.renderPlaygroundTable();

// А. В таблице
const newTbodyHtml = getMockEl('pgTableBody').innerHTML;
const newRowHtml = findRowById(newTbodyHtml, '#new_101');
assert(newRowHtml, "Строка #new_101 должна присутствовать в таблице");
console.log("Таблица (#new_101) содержит раздельные A и B?");
assert(newRowHtml.includes('A: 5/4/3/5'), "Таблица должна содержать 'A: 5/4/3/5'");
assert(newRowHtml.includes('B: 4/3/5/2'), "Таблица должна содержать 'B: 4/3/5/2'");
assert(!newRowHtml.includes('Оценки старого формата'), "Таблица не должна помечать новую запись как старую");
console.log("✓ Таблица корректно показывает раздельные A: 5/4/3/5 и B: 4/3/5/2");

// Б. В окне просмотра
context.viewDatasetItem('new_101');
const newModalHtml = getMockEl('datasetItemModalContent').innerHTML;
assert(newModalHtml.includes('Оценки Модели A'), "Модальное окно должно содержать блок 'Оценки Модели A'");
assert(newModalHtml.includes('Оценки Модели B'), "Модальное окно должно содержать блок 'Оценки Модели B'");
assert(!newModalHtml.includes('Оценки старого формата — модель не указана'), "Модальное окно не должно показывать плашку старого формата для новой записи");
console.log("✓ Окно просмотра отображает два отдельных блока для Модели A и Модели B");

// В. В экспорте
context.exportSingleItemJSONL('new_101');
const newExportObj = JSON.parse(lastExportedBlob.trim());
console.log("Экспорт JSONL (#new_101):");
console.log("  scores_a:", newExportObj.scores_a);
console.log("  scores_b:", newExportObj.scores_b);
console.log("  scores_chosen:", newExportObj.scores_chosen);
console.log("  scores_rejected:", newExportObj.scores_rejected);

assert.deepStrictEqual(newExportObj.scores_a, newDpoRecord.scores.scores_a);
assert.deepStrictEqual(newExportObj.scores_b, newDpoRecord.scores.scores_b);
assert.deepStrictEqual(newExportObj.scores_chosen, newDpoRecord.scores.scores_a);
assert.deepStrictEqual(newExportObj.scores_rejected, newDpoRecord.scores.scores_b);
assert.strictEqual(newExportObj.legacy_notice, undefined, "В новой записи не должно быть legacy_notice");
assert.strictEqual(newExportObj.scores_legacy, undefined, "В новой записи не должно быть scores_legacy");
console.log("✓ Экспорт JSONL сохраняет scores_a и scores_b отдельно");

console.log("\n=================================================================");
console.log(">>> ВСЕ ПРОВЕРКИ УСПЕШНО ПРОЙДЕНЫ! <<<");
console.log("=================================================================");
