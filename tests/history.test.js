import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../app/src/history.js';

test('отмена и повтор возвращают нужные состояния', () => {
  const h = createHistory();
  let state = { n: 1 };
  h.push(state); state = { n: 2 };
  h.push(state); state = { n: 3 };
  state = h.undo(state); assert.equal(state.n, 2);
  state = h.undo(state); assert.equal(state.n, 1);
  assert.equal(h.undo(state), null);
  state = h.redo(state); assert.equal(state.n, 2);
  h.push(state); state = { n: 9 };
  assert.equal(h.canRedo(), false, 'новая правка отбрасывает «вперёд»');
});

test('история не хранит больше лимита', () => {
  const h = createHistory(3);
  for (let i = 0; i < 10; i++) h.push({ i });
  let s = { i: 10 }, steps = 0;
  while ((s = h.undo(s))) steps++;
  assert.equal(steps, 3);
});
