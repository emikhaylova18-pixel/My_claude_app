// Сборка готового SVG-файла из проекта.

import { pathD } from './geometry.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * project: { width, height, background, smooth, outline, shapes: [{ fill, pts, hidden }] }
 * outline = true — только линии (схема для раскраски), иначе заливка.
 */
export function projectToSVG(project, { scale = 1 } = {}) {
  const { width: w, height: h, shapes, smooth = true, outline = false } = project;
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="0 0 ${w} ${h}">`);
  if (outline) {
    lines.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
    lines.push(`<g fill="none" stroke="#1f1a1c" stroke-width="${esc(Math.max(0.6, w / 600))}" stroke-linejoin="round">`);
    for (const s of shapes) if (!s.hidden) lines.push(`<path d="${pathD(s.pts, smooth)}"/>`);
    lines.push('</g>');
  } else {
    lines.push(`<rect width="${w}" height="${h}" fill="${esc(project.background || '#ffffff')}"/>`);
    lines.push('<g stroke-linejoin="round">');
    for (const s of shapes) {
      if (s.hidden) continue;
      // Тонкая обводка цветом заливки закрывает волосяные щели между соседними фигурами.
      lines.push(`<path d="${pathD(s.pts, smooth)}" fill="${esc(s.fill)}" stroke="${esc(s.fill)}" stroke-width="0.6"/>`);
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}
