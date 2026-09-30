// Коррекция фото: свет, цвет и детали.
// Все функции работают с картинкой вида { width, height, data: Uint8ClampedArray RGBA }
// и ничего не знают о браузере, поэтому проверяются тестами в Node.

export const PARAMS = [
  { key: 'exposure', label: 'Экспозиция', group: 'Свет', min: -100, max: 100 },
  { key: 'contrast', label: 'Контраст', group: 'Свет', min: -100, max: 100 },
  { key: 'highlights', label: 'Светлые', group: 'Свет', min: -100, max: 100 },
  { key: 'shadows', label: 'Тени', group: 'Свет', min: -100, max: 100 },
  { key: 'whites', label: 'Белые', group: 'Свет', min: -100, max: 100 },
  { key: 'blacks', label: 'Чёрные', group: 'Свет', min: -100, max: 100 },
  { key: 'temperature', label: 'Теплота', group: 'Цвет', min: -100, max: 100 },
  { key: 'tint', label: 'Оттенок', group: 'Цвет', min: -100, max: 100 },
  { key: 'vibrance', label: 'Сочность', group: 'Цвет', min: -100, max: 100 },
  { key: 'saturation', label: 'Насыщенность', group: 'Цвет', min: -100, max: 100 },
  { key: 'sharpen', label: 'Резкость', group: 'Детали', min: -100, max: 100 },
  { key: 'clarity', label: 'Чёткость', group: 'Детали', min: -100, max: 100 },
  { key: 'vignette', label: 'Виньетка', group: 'Детали', min: -100, max: 100 },
  { key: 'fade', label: 'Выцветание', group: 'Детали', min: 0, max: 100 },
  { key: 'grain', label: 'Зерно', group: 'Детали', min: 0, max: 100 },
];

export const DEFAULTS = Object.freeze(Object.fromEntries(PARAMS.map((p) => [p.key, 0])));
export const RANGE = Object.fromEntries(PARAMS.map((p) => [p.key, [p.min, p.max]]));

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TAU = Math.PI * 2;

/** Нужна ли хоть какая-то обработка. mono и grade — эффекты фильтров. */
export function isIdentity(p) {
  for (const { key } of PARAMS) if (p[key]) return false;
  return !(p.mono > 0) && !(p.grade && p.grade.amount > 0);
}

/** Множители каналов для баланса белого. Яркость при этом почти не меняется. */
export function wbGains(temperature = 0, tint = 0) {
  const t = temperature / 100;
  const g = tint / 100;
  let r = 1 + 0.2 * t;
  let gg = 1;
  let b = 1 - 0.2 * t;
  // Оттенок: плюс — в пурпурный (меньше зелёного), минус — в зелёный.
  gg *= 1 - 0.14 * g;
  r *= 1 + 0.04 * g;
  b *= 1 + 0.04 * g;
  const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  return [r / lum, gg / lum, b / lum];
}

/**
 * Тоновая кривая: x от 0 до 1 → результат от 0 до 1.
 * Каждое движение ползунка подобрано так, чтобы кривая не «переворачивалась»:
 * более светлая точка всегда остаётся не темнее более тёмной.
 */
export function tone(x, p) {
  if (p.exposure) {
    // Экспозиция в линейном свете: ±2 ступени. При осветлении светлые мягко «прижимаются» к белому.
    const g = Math.pow(2, p.exposure / 50);
    let lin = Math.pow(x, 2.2);
    lin = g > 1 ? (lin * g) / (1 + (g - 1) * lin) : lin * g;
    x = Math.pow(clamp01(lin), 1 / 2.2);
  }
  if (p.contrast) {
    const c = (p.contrast / 100) * 0.7;
    x = x - (c * Math.sin(TAU * x)) / TAU;
  }
  if (p.highlights) {
    // «Горб» с вершиной в светлых (x = 0.75): тёмные почти не затрагиваются.
    const a = (p.highlights / 100) * (p.highlights > 0 ? 0.1 : 0.3);
    x += a * 9.48 * x * x * x * (1 - x);
  }
  if (p.shadows) {
    // Зеркальный «горб» с вершиной в тенях (x = 0.25).
    const a = (p.shadows / 100) * (p.shadows > 0 ? 0.3 : 0.1);
    const k = 1 - x;
    x += a * 9.48 * x * k * k * k;
  }
  if (p.whites) x += (p.whites / 100) * 0.15 * x * x * x;
  if (p.blacks) {
    const k = 1 - x;
    x += (p.blacks / 100) * 0.15 * k * k * k;
  }
  x = clamp01(x);
  if (p.fade) {
    const f = p.fade / 100;
    x = f * 0.14 + x * (1 - f * 0.19);
  }
  return x;
}

/** Три таблицы по 256 значений: баланс белого + тоновая кривая для каждого канала. */
export function buildLUTs(p) {
  const gains = wbGains(p.temperature, p.tint);
  return gains.map((m) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * tone(clamp01((i / 255) * m), p));
    return lut;
  });
}

/**
 * Размытие «коробкой» три раза подряд — почти гауссово, но за линейное время.
 * Работает с любым типизированным массивом одного канала; возвращает новый массив того же типа.
 */
export function boxBlur(src, w, h, r, passes = 3) {
  r = Math.max(1, Math.round(r));
  const Ctor = src.constructor;
  let a = new Ctor(src);
  const tmp = new Ctor(src.length);
  for (let pass = 0; pass < passes; pass++) {
    blurLine(a, tmp, w, h, r, 1, w); // по строкам
    blurLine(tmp, a, h, w, r, w, 1); // по столбцам
  }
  return a;
}

// Одна проходка размытия вдоль линий. step — шаг внутри линии, stride — шаг между линиями.
function blurLine(src, dst, len, lines, r, step, stride) {
  const win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    const first = src[base];
    const last = src[base + (len - 1) * step];
    let sum = first * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[base + Math.min(i, len - 1) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum / win;
      const add = i + r + 1;
      const sub = i - r;
      sum += (add < len ? src[base + add * step] : last) - (sub >= 0 ? src[base + sub * step] : first);
    }
  }
}

/** Детерминированный шум от −1 до 1: одинаковое зерно при каждой перерисовке. */
export function noise(x, y, seed = 7) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffff) / 32767.5 - 1;
}

const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Применяет коррекцию прямо к img.data и возвращает img.
 * p — значения ползунков (от −100 до 100) и эффекты фильтров:
 *   mono — от 0 до 1, насколько обесцветить;
 *   grade — { shadows: [r,g,b], highlights: [r,g,b], amount } — тонирование теней и светов.
 */
export function applyAdjustments(img, params, opts = {}) {
  const p = { ...DEFAULTS, ...params };
  if (isIdentity(p)) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const [lr, lg, lb] = buildLUTs(p);
  const sat = p.saturation / 100;
  const vib = p.vibrance / 100;
  const mono = clamp01(p.mono || 0);
  const grade = p.grade && p.grade.amount > 0 ? p.grade : null;
  const gs = grade ? grade.shadows : null;
  const gh = grade ? grade.highlights : null;
  const ga = grade ? grade.amount * 60 : 0;
  const color = sat || vib || mono || grade;

  // 1. Свет и цвет: таблицы + насыщенность, сочность, обесцвечивание, тонирование.
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let r = lr[data[o]];
    let g = lg[data[o + 1]];
    let b = lb[data[o + 2]];
    if (color) {
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let k = 1 + sat;
      if (vib) {
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
        const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        k *= 1 + vib * (1 - (mx - mn) / 255);
      }
      if (mono) k *= 1 - mono;
      if (k !== 1) {
        r = L + (r - L) * k;
        g = L + (g - L) * k;
        b = L + (b - L) * k;
      }
      if (grade) {
        const l = L / 255;
        const ws = (1 - l) * (1 - l);
        const wh = l * l;
        r += ga * (ws * gs[0] + wh * gh[0]);
        g += ga * (ws * gs[1] + wh * gh[1]);
        b += ga * (ws * gs[2] + wh * gh[2]);
      }
    }
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }

  // 2. Резкость и чёткость — по яркости, чтобы по краям не появлялись цветные ореолы.
  if (p.sharpen || p.clarity) {
    const L = new Uint8ClampedArray(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) L[i] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    const long = Math.max(w, h);
    const add = (blurred, amount, midtones) => {
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        let d = L[i] - blurred[i];
        if (midtones) {
          const t = (2 * L[i]) / 255 - 1;
          d *= 1 - t * t;
        }
        d *= amount;
        data[o] += d;
        data[o + 1] += d;
        data[o + 2] += d;
      }
    };
    if (p.sharpen) {
      const r = opts.sharpenRadius ?? Math.max(1, Math.round(long / 1400));
      add(boxBlur(L, w, h, r), (p.sharpen / 100) * (p.sharpen > 0 ? 1.6 : 1), false);
    }
    if (p.clarity) {
      const r = opts.clarityRadius ?? Math.max(2, Math.round(long / 45));
      add(boxBlur(L, w, h, r), (p.clarity / 100) * 0.9, true);
    }
  }

  // 3. Виньетка и зерно.
  if (p.vignette || p.grain) {
    const v = p.vignette / 100;
    const gAmt = (p.grain / 100) * 26;
    const seed = opts.seed ?? 7;
    const hw = w / 2;
    const hh = h / 2;
    for (let y = 0, o = 0; y < h; y++) {
      const dy = (y + 0.5 - hh) / hh;
      for (let x = 0; x < w; x++, o += 4) {
        let r = data[o];
        let g = data[o + 1];
        let b = data[o + 2];
        if (v) {
          const dx = (x + 0.5 - hw) / hw;
          const t = smoothstep(0.35, 1.05, Math.sqrt((dx * dx + dy * dy) / 2));
          const f = t * t * 0.75 * v;
          if (f > 0) {
            r *= 1 - f;
            g *= 1 - f;
            b *= 1 - f;
          } else if (f < 0) {
            r += (255 - r) * -f;
            g += (255 - g) * -f;
            b += (255 - b) * -f;
          }
        }
        if (gAmt) {
          const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const d = noise(x, y, seed) * gAmt * (0.35 + 0.65 * (1 - Math.abs(2 * l - 1)));
          r += d;
          g += d;
          b += d;
        }
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
      }
    }
  }
  return img;
}

/** Гистограмма: сколько пикселей каждой яркости. step — брать каждый step-й пиксель. */
export function histogram(img, step = 1) {
  const { data, width, height } = img;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  const n = width * height;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    r[data[o]]++;
    g[data[o + 1]]++;
    b[data[o + 2]]++;
    l[Math.round(0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2])]++;
  }
  return { r, g, b, l };
}

function percentile(hist, q) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

/**
 * «Авто»: подбирает свет и цвет по гистограмме.
 * Возвращает только ключи света и цвета — детали остаются как были.
 */
export function autoParams(img) {
  const step = Math.max(1, Math.floor((img.width * img.height) / 60000));
  const hist = histogram(img, step);
  const lo = percentile(hist.l, 0.005);
  const hi = percentile(hist.l, 0.995);
  const med = percentile(hist.l, 0.5);
  let count = 0;
  let sr = 0, sg = 0, sb = 0, sSat = 0, dark = 0, bright = 0;
  const { data } = img;
  const n = img.width * img.height;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    sr += r; sg += g; sb += b;
    sSat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (L < 28) dark++;
    if (L > 238) bright++;
    count++;
  }
  const p = {};
  const m = Math.max(0.02, med / 255);
  // Не тянем всё к серой середине: закат может быть светлым, а ночь — тёмной.
  // Поправляем только то, что вышло за комфортные границы.
  const target = clamp(m, 0.36, 0.6);
  if (Math.abs(m - target) > 0.01) {
    const ev = Math.log2(Math.pow(target, 2.2) / Math.pow(m, 2.2));
    p.exposure = Math.round(clamp(ev * 50 * 0.75, -60, 70));
  } else p.exposure = 0;
  const spread = hi - lo;
  p.contrast = spread < 200 ? Math.round(clamp((200 - spread) * 0.25, 0, 30)) : 0;
  p.blacks = lo > 12 ? -Math.round(clamp((lo - 6) * 2.2, 0, 55)) : 0;
  p.whites = hi < 240 ? Math.round(clamp((248 - hi) * 1.6, 0, 50)) : 0;
  const fb = bright / count;
  const fd = dark / count;
  p.highlights = fb > 0.02 ? -Math.round(clamp(fb * 700, 10, 60)) : 0;
  p.shadows = fd > 0.04 ? Math.round(clamp(fd * 350, 10, 50)) : 0;
  const mr = sr / count, mg = sg / count, mb = sb / count;
  const mean = (mr + mg + mb) / 3 || 1;
  p.temperature = Math.round(clamp(((mb - mr) / mean) * 120, -40, 40));
  p.tint = Math.round(clamp(((mg - (mr + mb) / 2) / mean) * 120, -30, 30));
  const avgSat = sSat / count;
  p.vibrance = avgSat < 0.35 ? Math.round(clamp((0.35 - avgSat) * 90, 5, 25)) : 0;
  p.saturation = 0;
  return p;
}
