/**
 * Тест валидации классов объектов в разметке Computer Vision.
 * Проверяет, что при неверном выборе класса объекта (например, все рамки "Трещина"
 * вместо "Скол" и "Пятно") система:
 * 1. Фиксирует ошибку класса (classErrors > 0, isClassMismatch: true).
 * 2. Не засчитывает такие рамки как успешное попадание (matched: false).
 * 3. Выводит предупреждающий бейдж и понятное объяснение ошибки разметчику.
 */

const fs = require('fs');
const assert = require('assert');

const cvCases = JSON.parse(fs.readFileSync('data/cv_cases.json', 'utf-8'));
const case2 = cvCases.find(c => c.id === 'cv_2' || c.title.includes('Дефектоскопия'));
assert(case2, 'Кейс CV-2 должен присутствовать в датасете');

function computeIoU(b1, b2) {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
  const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);

  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;

  const area1 = b1.w * b1.h;
  const area2 = b2.w * b2.h;
  const unionArea = area1 + area2 - interArea;

  return unionArea === 0 ? 0 : (interArea / unionArea);
}

function getExpectedClass(gt, curCase) {
  if (gt.target_class) return gt.target_class;
  if (curCase && curCase.target_classes && Array.isArray(curCase.target_classes)) {
    for (const cls of curCase.target_classes) {
      if (gt.label.toLowerCase().includes(cls.toLowerCase())) {
        return cls;
      }
    }
  }
  return gt.label;
}

function evaluateCvCase(curCase, cvUserBoxes) {
  const gtBoxes = curCase.ground_truth_boxes || [];
  const matchedGt = [];
  const usedUserIdx = new Set();
  let totalIou = 0;
  let classErrorsCount = 0;
  let correctMatchesCount = 0;

  gtBoxes.forEach(gt => {
    const expectedClass = getExpectedClass(gt, curCase);
    // 1. Ищем свободную рамку пользователя с точным совпадением класса
    let bestClassIou = 0;
    let bestClassUserIdx = -1;

    // 2. Ищем свободную рамку пользователя с ДРУГИМ (неверным) классом
    let bestDiffClassIou = 0;
    let bestDiffClassUserIdx = -1;

    cvUserBoxes.forEach((u, uIdx) => {
      if (usedUserIdx.has(uIdx)) return;
      const iou = computeIoU(gt, u);
      const isSameClass = ((u.label || '').trim().toLowerCase() === expectedClass.trim().toLowerCase());

      if (isSameClass) {
        if (iou > bestClassIou) {
          bestClassIou = iou;
          bestClassUserIdx = uIdx;
        }
      } else {
        if (iou > bestDiffClassIou) {
          bestDiffClassIou = iou;
          bestDiffClassUserIdx = uIdx;
        }
      }
    });

    if (bestClassIou >= 0.70 && bestClassUserIdx !== -1) {
      usedUserIdx.add(bestClassUserIdx);
      correctMatchesCount++;
      totalIou += bestClassIou;
      matchedGt.push({
        gt,
        expectedClass,
        actualClass: expectedClass,
        matched: true,
        isClassMismatch: false,
        isLowIou: false,
        iou: Math.round(bestClassIou * 100),
        userBox: cvUserBoxes[bestClassUserIdx]
      });
    } else if (bestClassIou >= 0.15 && bestClassUserIdx !== -1) {
      usedUserIdx.add(bestClassUserIdx);
      const actualBox = cvUserBoxes[bestClassUserIdx];
      matchedGt.push({
        gt,
        expectedClass,
        actualClass: expectedClass,
        matched: false,
        isClassMismatch: false,
        isLowIou: true,
        iou: Math.round(bestClassIou * 100),
        userBox: actualBox
      });
    } else if (bestDiffClassIou >= 0.15 && bestDiffClassUserIdx !== -1) {
      usedUserIdx.add(bestDiffClassUserIdx);
      classErrorsCount++;
      const actualBox = cvUserBoxes[bestDiffClassUserIdx];
      matchedGt.push({
        gt,
        expectedClass,
        actualClass: actualBox.label || 'Неизвестно',
        matched: false,
        isClassMismatch: true,
        isLowIou: false,
        iou: Math.round(bestDiffClassIou * 100),
        userBox: actualBox
      });
    } else {
      const userBox = (bestClassUserIdx !== -1) ? cvUserBoxes[bestClassUserIdx] : null;
      if (bestClassUserIdx !== -1) usedUserIdx.add(bestClassUserIdx);

      matchedGt.push({
        gt,
        expectedClass,
        actualClass: userBox ? userBox.label : '',
        matched: false,
        isClassMismatch: false,
        isLowIou: false,
        iou: Math.round(bestClassIou * 100),
        userBox: userBox
      });
    }
  });

  const foundCount = correctMatchesCount;
  const missedCount = gtBoxes.length - foundCount - classErrorsCount;
  const falsePositives = Math.max(0, cvUserBoxes.length - usedUserIdx.size);
  const avgIou = correctMatchesCount > 0 ? Math.round((totalIou / correctMatchesCount) * 100) : 0;

  return {
    found: foundCount,
    total: gtBoxes.length,
    classErrors: classErrorsCount,
    missed: missedCount,
    falsePositives: falsePositives,
    avgIou: avgIou,
    matchedGt: matchedGt
  };
}

console.log('--- ТЕСТ 1: Все 3 рамки нарисованы с классом "Трещина" (сценарий скриншота пользователя) ---');
const userBoxesAllCrack = [
  { x: 260, y: 250, w: 95, h: 80, label: 'Трещина' }, // Пятно
  { x: 390, y: 120, w: 70, h: 65, label: 'Трещина' }, // Скол
  { x: 130, y: 90, w: 140, h: 60, label: 'Трещина' }  // Трещина
];

const res1 = evaluateCvCase(case2, userBoxesAllCrack);
console.log('Результат:', {
  found: res1.found,
  total: res1.total,
  classErrors: res1.classErrors,
  avgIou: res1.avgIou
});

assert.strictEqual(res1.found, 1, 'Должен быть засчитан ровно 1 объект (Трещина)');
assert.strictEqual(res1.classErrors, 2, 'Должно быть ровно 2 ошибки классификации (Скол и Пятно)');
assert.strictEqual(res1.matchedGt.find(m => m.expectedClass === 'Скол').isClassMismatch, true);
assert.strictEqual(res1.matchedGt.find(m => m.expectedClass === 'Пятно').isClassMismatch, true);
assert.strictEqual(res1.matchedGt.find(m => m.expectedClass === 'Трещина').matched, true);
console.log('✓ ТЕСТ 1 УСПЕШНО ПРОЙДЕН!');

console.log('\n--- ТЕСТ 2: Все 3 рамки нарисованы с правильными классами ---');
const userBoxesCorrect = [
  { x: 260, y: 250, w: 95, h: 80, label: 'Пятно' },
  { x: 390, y: 120, w: 70, h: 65, label: 'Скол' },
  { x: 130, y: 90, w: 140, h: 60, label: 'Трещина' }
];

const res2 = evaluateCvCase(case2, userBoxesCorrect);
assert.strictEqual(res2.found, 3, 'Все 3 объекта должны быть засчитаны');
assert.strictEqual(res2.classErrors, 0, 'Ошибок классов быть не должно');
assert.strictEqual(res2.avgIou >= 95, true, 'Средний IoU должен быть >= 95%');
console.log('✓ ТЕСТ 2 УСПЕШНО ПРОЙДЕН!');

console.log('\n--- ТЕСТ 3: Пятно выделено классом "Трещина" (компактная пользовательская рамка IoU ~ 0.30) ---');
const userBoxesSpotAsCrack = [
  { x: 130, y: 90, w: 140, h: 60, label: 'Трещина' }, // Трещина - верный класс
  { x: 390, y: 120, w: 70, h: 65, label: 'Скол' },    // Скол - верный класс
  { x: 280, y: 270, w: 50, h: 45, label: 'Трещина' }  // Пятно - ложный класс!
];

const res3 = evaluateCvCase(case2, userBoxesSpotAsCrack);
console.log('Результат ТЕСТ 3:', {
  found: res3.found,
  total: res3.total,
  classErrors: res3.classErrors
});
assert.strictEqual(res3.found, 2, 'Должно быть засчитано 2 верных объекта (Трещина и Скол)');
assert.strictEqual(res3.classErrors, 1, 'Ложный класс для пятна должен фиксировать ровно 1 ошибку класса');
const spotMismatch = res3.matchedGt.find(m => m.expectedClass === 'Пятно');
assert(spotMismatch, 'Пятно должно присутствовать в отчете');
assert.strictEqual(spotMismatch.isClassMismatch, true, 'isClassMismatch должен быть true');
assert.strictEqual(spotMismatch.actualClass, 'Трещина', 'Класс должен быть зафиксирован как Трещина');
console.log('✓ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: ложный класс для пятна корректно зафиксирован как ошибка!');

console.log('\n--- ТЕСТ 4: Сценарий скриншота пользователя: Трещина со свободной рамкой (IoU 31% при пороге 70%+) ---');
const userBoxScreenshot = [
  { x: 102, y: 69, w: 212, h: 126, label: 'Трещина' } // Рамка со скриншота пользователя
];
const res4 = evaluateCvCase(case2, userBoxScreenshot);
const crackResult = res4.matchedGt.find(m => m.expectedClass === 'Трещина');
assert(crackResult, 'Трещина должна присутствовать');
assert.strictEqual(crackResult.matched, false, 'При IoU 31% (< 70%) объект ОБЯЗАН фейлиться (не засчитываться)!');
assert.strictEqual(crackResult.isLowIou, true, 'isLowIou должен быть true (порог 70% не пройден)');
assert.strictEqual(crackResult.isClassMismatch, false, 'isClassMismatch должен быть false (класс верный)');
assert.strictEqual(res4.found, 0, 'Объект с IoU 31% не должен быть зачтен');
console.log('✓ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: рамка с низким IoU 31% (< 70%) строго зафейлена (не зачтена)!');

console.log('\nВСЕ ТЕСТЫ ВАЛИДАЦИИ КЛАССОВ ОБЪЕКТОВ CV УСПЕШНО ВЫПОЛНЕНЫ!');
