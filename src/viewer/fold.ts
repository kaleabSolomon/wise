/**
 * Which runs of unchanged lines in a code diff are worth folding away.
 *
 * Kept free of any DOM reference so it can be tested in Node: the viewer
 * client turns rendered diff rows into the boolean array this takes, and turns
 * the ranges it returns back into hidden rows.
 */

/** Unchanged lines kept either side of a fold, so a change never sits flush. */
export const FOLD_EDGE = 3;

/** Runs shorter than this stay put — hiding four lines behind a click is worse
 * than showing them. */
export const FOLD_MIN = 10;

/** Half-open range `[start, end)` of row indices a fold hides. */
export interface FoldRun {
  start: number;
  end: number;
}

/**
 * Given one flag per diff row — true where every side of the diff shows an
 * unchanged line — return the ranges worth hiding.
 *
 * Runs are trimmed by `FOLD_EDGE` at both ends, including at the very top and
 * bottom of the file: the first lines of a function are usually its signature,
 * which is the context a reader wants even when nothing there changed.
 */
export function foldableRuns(unchanged: readonly boolean[]): FoldRun[] {
  const runs: FoldRun[] = [];

  let i = 0;
  while (i < unchanged.length) {
    if (!unchanged[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < unchanged.length && unchanged[end]) end++;
    if (end - i >= FOLD_MIN) {
      runs.push({ start: i + FOLD_EDGE, end: end - FOLD_EDGE });
    }
    i = end;
  }
  return runs;
}
