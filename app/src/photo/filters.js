// Фильтры — готовые наборы коррекции. Они добавляются поверх ползунков пользователя,
// поэтому свои настройки не пропадают, а силу фильтра можно уменьшить.

import { DEFAULTS, RANGE } from './adjust.js';

export const FILTERS = [
  { id: 'none', name: 'Оригинал', p: {} },
  { id: 'vivid', name: 'Яркий', p: { contrast: 18, vibrance: 40, saturation: 8, clarity: 15 } },
  { id: 'warm', name: 'Тёплый вечер', p: { temperature: 35, tint: 6, highlights: -15, shadows: 12, vibrance: 15, vignette: 18 } },
  { id: 'cool', name: 'Прохлада', p: { temperature: -32, tint: -4, contrast: 10, saturation: -8, highlights: 8 } },
  {
    id: 'pastel', name: 'Пастель',
    p: { exposure: 10, contrast: -25, highlights: -20, saturation: -22, fade: 35, tint: 10, grade: { shadows: [0.15, 0.05, 0.25], highlights: [0.3, 0.08, 0.12], amount: 0.6 } },
  },
  {
    id: 'cinema', name: 'Кино',
    p: { contrast: 25, saturation: -10, vignette: 25, fade: 8, grade: { shadows: [-0.6, 0.15, 0.55], highlights: [0.55, 0.15, -0.5], amount: 0.8 } },
  },
  {
    id: 'vintage', name: 'Винтаж',
    p: { fade: 40, temperature: 25, saturation: -30, grain: 35, vignette: 35, grade: { shadows: [0.1, 0.2, -0.3], highlights: [0.4, 0.25, -0.1], amount: 0.7 } },
  },
  { id: 'soft', name: 'Мягкий', p: { exposure: 5, sharpen: -40, clarity: -30, highlights: -10, shadows: 15, fade: 10 } },
  { id: 'drama', name: 'Драма', p: { clarity: 60, contrast: 30, saturation: -25, highlights: -40, shadows: 30, vignette: 30 } },
  { id: 'bw', name: 'Ч/Б', p: { mono: 1, contrast: 25, clarity: 15 } },
  { id: 'noir', name: 'Нуар', p: { mono: 1, contrast: 55, blacks: -30, vignette: 45, grain: 20, clarity: 25 } },
  {
    id: 'sepia', name: 'Сепия',
    p: { mono: 1, contrast: 5, fade: 10, grade: { shadows: [0.35, 0.1, -0.35], highlights: [0.45, 0.25, -0.2], amount: 0.9 } },
  },
];

export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

/**
 * Итоговые параметры: ползунки пользователя + фильтр с силой amount (0–100).
 * Результат остаётся в допустимых границах каждого ползунка.
 */
export function combineParams(user, filterId = 'none', amount = 100) {
  const f = filterById(filterId);
  const k = Math.max(0, Math.min(1, amount / 100));
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const [lo, hi] = RANGE[key];
    const v = (user[key] || 0) + (f.p[key] || 0) * k;
    out[key] = Math.max(lo, Math.min(hi, v));
  }
  out.mono = Math.max(0, Math.min(1, (user.mono || 0) + (f.p.mono || 0) * k));
  out.grade = f.p.grade ? { ...f.p.grade, amount: f.p.grade.amount * k } : null;
  return out;
}
