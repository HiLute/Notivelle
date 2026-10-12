/**
 * Самая короткая замена, превращающая `before` в `after`: общие начало и
 * конец не трогаем. `offset` — где `before` начинается в документе.
 *
 * Так правка затрагивает только изменившийся кусок: курсор и выделение в
 * остальном тексте остаются на месте, а история отмены получает маленький шаг.
 */
export function textChange(before: string, after: string, offset = 0): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: offset + start, to: offset + before.length - end, insert: after.slice(start, after.length - end) };
}
