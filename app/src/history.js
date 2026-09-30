// История изменений для кнопок «Отменить» и «Повторить».
// Хранит снимки состояния; при новой правке ветка «вперёд» отбрасывается.

const deepCopy = (s) => JSON.parse(JSON.stringify(s));

/**
 * limit — сколько шагов помнить.
 * clone — как копировать состояние. Редактор передаёт лёгкую копию:
 * фигуры в нём не меняются на месте, поэтому достаточно скопировать список ссылок.
 */
export function createHistory(limit = 40, clone = deepCopy) {
  let past = [];
  let future = [];
  const copy = clone;
  return {
    /** Запомнить состояние ДО правки. */
    push(state) {
      past.push(copy(state));
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(current) {
      if (!past.length) return null;
      future.push(copy(current));
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(copy(current));
      return future.pop();
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() { past = []; future = []; },
  };
}
