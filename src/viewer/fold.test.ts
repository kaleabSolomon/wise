import { describe, it, expect } from "vitest";
import { html } from "diff2html";
import { foldableRuns, FOLD_EDGE, FOLD_MIN } from "./fold.js";
import { buildCodeDiff } from "./server.js";

const flags = (pattern: string): boolean[] =>
  [...pattern].map((c) => c === ".");

describe("foldableRuns", () => {
  it("leaves a diff with no long unchanged run alone", () => {
    expect(foldableRuns(flags("..x..x.."))).toEqual([]);
  });

  it("ignores a run one line short of the threshold", () => {
    expect(foldableRuns(flags("x".padEnd(FOLD_MIN, ".")))).toEqual([]);
  });

  it("folds a long run, keeping context at both ends", () => {
    // 20 unchanged lines between two changes.
    const runs = foldableRuns(flags("x" + ".".repeat(20) + "x"));
    expect(runs).toEqual([{ start: 1 + FOLD_EDGE, end: 21 - FOLD_EDGE }]);
  });

  it("keeps the top of the file visible rather than folding from line one", () => {
    const [run] = foldableRuns(flags(".".repeat(20) + "x"));
    expect(run?.start).toBe(FOLD_EDGE);
  });

  it("folds each run independently", () => {
    const runs = foldableRuns(flags(".".repeat(15) + "x" + ".".repeat(15)));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.end).toBe(15 - FOLD_EDGE);
    expect(runs[1]?.start).toBe(16 + FOLD_EDGE);
  });

  it("handles an empty diff", () => {
    expect(foldableRuns([])).toEqual([]);
  });
});

/*
 * The client derives its flags from rendered diff2html rows, so the shape of
 * that markup is part of the contract. This drives the real renderer and reads
 * the rows back, which would catch diff2html changing its class names.
 */
describe("foldableRuns — against real diff2html output", () => {
  const line = (i: number) => `  const step${i} = items.length + ${i};`;
  const oldCode = [
    "function processOrder(order) {",
    ...Array.from({ length: 25 }, (_, i) => line(i)),
    "  const tax = subtotal * 0.2;",
    ...Array.from({ length: 25 }, (_, i) => line(i + 100)),
    "}",
  ].join("\n");
  const newCode = oldCode.replace(
    "subtotal * 0.2",
    "subtotal * RATES.standard",
  );

  function render(oldSrc: string, newSrc: string): string {
    return html(buildCodeDiff(oldSrc, newSrc, "orders.ts"), {
      drawFileList: false,
      matching: "lines",
      outputFormat: "side-by-side",
    });
  }

  /** Per-side flags: is this rendered row an unchanged line on this side? */
  function sideFlags(markup: string): boolean[][] {
    return markup
      .split("d2h-file-side-diff")
      .slice(1)
      .map((side) =>
        [...side.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(
          (m) =>
            m[0].includes("d2h-cntx") && !/d2h-info|d2h-ins|d2h-del/.test(m[0]),
        ),
      );
  }

  /**
   * The client's rule: a row is foldable only when *every* side calls it
   * unchanged. The insertion test below is why one side isn't enough.
   */
  function unchangedFlags(markup: string): boolean[] {
    const sides = sideFlags(markup);
    const first = sides[0] ?? [];
    return first.map((_, i) => sides.every((side) => side[i] === true));
  }

  it("folds the untouched stretches either side of a one-line edit", () => {
    const unchanged = unchangedFlags(render(oldCode, newCode));
    // Sanity: the full-file patch really does render every line.
    expect(unchanged.length).toBeGreaterThan(50);

    const runs = foldableRuns(unchanged);
    expect(runs).toHaveLength(2);

    // Every folded row is genuinely unchanged — a fold must never hide an edit.
    for (const run of runs) {
      for (let i = run.start; i < run.end; i++) {
        expect(unchanged[i], `row ${i} inside a fold`).toBe(true);
      }
      expect(run.end - run.start).toBeGreaterThan(0);
    }

    // And the fold is worth making: most of the file collapses.
    const hidden = runs.reduce((n, r) => n + (r.end - r.start), 0);
    expect(hidden).toBeGreaterThan(unchanged.length / 2);
  });

  it("never folds an inserted line, though one side calls its row unchanged", () => {
    // A pure insertion leaves an empty placeholder opposite it, and diff2html
    // classes that placeholder `d2h-cntx` — so a fold that trusted a single
    // side would hide the insertion. Both sides have to agree.
    const withInsert = oldCode.replace(
      "  const tax = subtotal * 0.2;",
      "  const tax = subtotal * 0.2;\n  const surcharge = tax * 0.1;",
    );
    const markup = render(oldCode, withInsert);

    const perSide = sideFlags(markup);
    const combined = unchangedFlags(markup);
    // The row where the sides disagree: an insert opposite a placeholder.
    // (A hunk header reads false on both, so "any side false" isn't enough.)
    const insertedRow = combined.findIndex(
      (_, i) =>
        perSide.some((side) => side[i] === true) &&
        perSide.some((side) => side[i] !== true),
    );
    expect(insertedRow).toBeGreaterThan(-1);

    // The placeholder side really does look unchanged on its own...
    // ...but the combined rule refuses it, so no fold can swallow it.
    expect(combined[insertedRow]).toBe(false);
    for (const run of foldableRuns(combined)) {
      expect(insertedRow >= run.start && insertedRow < run.end).toBe(false);
    }
  });
});
