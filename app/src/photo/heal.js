// Точечное восстановление — как «Восстанавливающая кисть» в Photoshop.
// 1. Вокруг пятна ищем участок с похожим окружением (сравниваем кольцо вокруг).
// 2. Переносим его текстуру на место пятна.
// 3. Плавно подгоняем цвет по краю, чтобы заплатка не была заметна.

/**
 * Лечит круглое пятно с центром (cx, cy) и радиусом r прямо в img.data.
 * Возвращает смещение источника { ox, oy } или { fallback: true },
 * если подходящего участка рядом нет (тогда пятно заполняется цветом краёв).
 */
export function healSpot(img, cx, cy, r) {
  const { width: w, height: h, data } = img;
  r = Math.max(1.5, r);
  const ring = Math.max(2, r * 0.45);
  const R = r + ring;
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(w - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(h - 1, Math.ceil(cy + R));
  const disk = [];
  const ringPts = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) disk.push(x, y, d);
      else if (d <= R) ringPts.push(x, y);
    }
  }
  if (!disk.length) return null;

  // 1. Поиск источника.
  let best = null;
  let bestScore = Infinity;
  const stepRing = Math.max(1, Math.floor(ringPts.length / 2 / 500)) * 2;
  const dists = [2.1 * R, 2.8 * R, 3.6 * R];
  for (let di = 0; di < dists.length; di++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2 + di * 0.2;
      const ox = Math.round(Math.cos(ang) * dists[di]);
      const oy = Math.round(Math.sin(ang) * dists[di]);
      if (x0 + ox < 0 || x1 + ox > w - 1 || y0 + oy < 0 || y1 + oy > h - 1) continue;
      let score = 0;
      for (let i = 0; i < ringPts.length; i += stepRing) {
        const t = (ringPts[i + 1] * w + ringPts[i]) * 4;
        const s = ((ringPts[i + 1] + oy) * w + ringPts[i] + ox) * 4;
        const dr = data[t] - data[s];
        const dg = data[t + 1] - data[s + 1];
        const db = data[t + 2] - data[s + 2];
        score += dr * dr + dg * dg + db * db;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { ox, oy };
      }
    }
  }

  // 2. Опорные точки на кольце: разница цвета «вокруг пятна» и «вокруг источника».
  const avg = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    let r0 = 0, g0 = 0, b0 = 0, c = 0;
    for (let yy = yi - 1; yy <= yi + 1; yy++) {
      if (yy < 0 || yy >= h) continue;
      for (let xx = xi - 1; xx <= xi + 1; xx++) {
        if (xx < 0 || xx >= w) continue;
        const o = (yy * w + xx) * 4;
        r0 += data[o]; g0 += data[o + 1]; b0 += data[o + 2]; c++;
      }
    }
    return c ? [r0 / c, g0 / c, b0 / c] : null;
  };
  const N = Math.max(12, Math.min(64, Math.round((2 * Math.PI * R) / 3)));
  const rr = r + ring * 0.5;
  const qx = [], qy = [], qv = [];
  for (let j = 0; j < N; j++) {
    const ang = (j / N) * Math.PI * 2;
    const x = cx + Math.cos(ang) * rr;
    const y = cy + Math.sin(ang) * rr;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
    const t = avg(x, y);
    if (!t) continue;
    if (best) {
      const s = avg(x + best.ox, y + best.oy);
      qv.push([t[0] - s[0], t[1] - s[1], t[2] - s[2]]);
    } else qv.push(t);
    qx.push(x);
    qy.push(y);
  }
  if (!qv.length) return null;

  // 3. Заплатка: текстура источника + плавная поправка цвета (или просто цвет краёв).
  for (let i = 0; i < disk.length; i += 3) {
    const x = disk[i];
    const y = disk[i + 1];
    const d = disk[i + 2];
    let sw = 0, cr = 0, cg = 0, cb = 0;
    for (let j = 0; j < qv.length; j++) {
      const ddx = x - qx[j];
      const ddy = y - qy[j];
      const wgt = 1 / (ddx * ddx + ddy * ddy + 1);
      sw += wgt;
      cr += wgt * qv[j][0];
      cg += wgt * qv[j][1];
      cb += wgt * qv[j][2];
    }
    cr /= sw; cg /= sw; cb /= sw;
    const o = (y * w + x) * 4;
    let nr = cr, ng = cg, nb = cb;
    if (best) {
      const s = ((y + best.oy) * w + x + best.ox) * 4;
      nr += data[s];
      ng += data[s + 1];
      nb += data[s + 2];
    }
    const alpha = Math.max(0, Math.min(1, (r + 0.5 - d) / 1.5));
    data[o] = data[o] + (nr - data[o]) * alpha;
    data[o + 1] = data[o + 1] + (ng - data[o + 1]) * alpha;
    data[o + 2] = data[o + 2] + (nb - data[o + 2]) * alpha;
  }
  return best || { fallback: true };
}

/** Применяет список точек ретуши. Координаты точек — в пикселях исходника, scale — во сколько раз уменьшена картинка. */
export function healAll(img, spots, scale = 1) {
  for (const s of spots) healSpot(img, s.x * scale, s.y * scale, s.r * scale);
  return img;
}
