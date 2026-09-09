import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import { saveExplanation, setAnchor, markStale } from "../store/queries.js";
import { runList, renderListResult } from "./list.js";

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-list-")));
const other = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-list-b-")));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function store(
  where: string,
  symbol: string,
  file: string,
  prose: string,
  updated?: number,
) {
  const row = saveExplanation(db, {
    repo: where,
    file_path: file,
    symbol,
    prose,
    code_snapshot: "c",
    ast_hash: "h",
  });
  if (updated !== undefined) {
    db.prepare(`UPDATE explanations SET updated_at = ? WHERE id = ?`).run(
      updated,
      row.id,
    );
  }
  return row;
}

describe("runList", () => {
  it("lists what is stored for the repo", () => {
    store(repo, "processOrder", "src/orders.ts", "Totals an order.");
    store(repo, "BitReader", "src/bits.ts", "Reads bits.");

    const result = runList(db, { repo });
    expect(result.repo).toBe(repo);
    expect(result.explanations.map((e) => e.symbol).sort()).toEqual([
      "BitReader",
      "processOrder",
    ]);
  });

  it("only lists the repo asked about", () => {
    // An agent working in one project has no use for another's symbols, and
    // no business seeing them.
    store(repo, "mine", "a.ts", "Ours.");
    store(other, "theirs", "b.ts", "Someone else's.");

    expect(runList(db, { repo }).explanations.map((e) => e.symbol)).toEqual([
      "mine",
    ]);
  });

  it("puts the most recently updated first", () => {
    store(repo, "older", "a.ts", "First.", 100);
    store(repo, "newer", "b.ts", "Second.", 200);

    expect(runList(db, { repo }).explanations.map((e) => e.symbol)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("accepts a repo spelled any other way", () => {
    // Locators are stored canonically; a trailing slash must not silently
    // list nothing.
    store(repo, "processOrder", "src/orders.ts", "Totals an order.");
    expect(runList(db, { repo: `${repo}/` }).explanations).toHaveLength(1);
  });

  it("gives a gist rather than the whole explanation", () => {
    const long = `A short opening line.\n\n${"filler ".repeat(400)}`;
    store(repo, "processOrder", "src/orders.ts", long);

    const [entry] = runList(db, { repo }).explanations;
    expect(entry?.gist).toBe("A short opening line.");
    expect(entry?.gist.length).toBeLessThan(200);
  });

  it("reports staleness and anchoring", () => {
    const row = store(repo, "anchored", "a.ts", "One.");
    setAnchor(db, row.id, "aabbccdd");
    store(repo, "plain", "b.ts", "Two.");
    markStale(db, { repo, file_path: "b.ts", symbol: "plain" });

    const byName = new Map(
      runList(db, { repo }).explanations.map((e) => [e.symbol, e]),
    );
    expect(byName.get("anchored")).toMatchObject({
      anchored: true,
      is_stale: false,
    });
    expect(byName.get("plain")).toMatchObject({
      anchored: false,
      is_stale: true,
    });
  });

  it("returns nothing for a repo with no explanations", () => {
    expect(runList(db, { repo }).explanations).toEqual([]);
  });
});

describe("renderListResult", () => {
  it("says plainly when there is nothing yet", () => {
    const text = renderListResult(runList(db, { repo }));
    expect(text).toContain("No explanations saved");
    expect(text).toContain("save_explanation");
  });

  it("lists each symbol with its file and gist", () => {
    store(repo, "processOrder", "src/orders.ts", "Totals an order.");
    const text = renderListResult(runList(db, { repo }));

    expect(text).toContain("processOrder");
    expect(text).toContain("src/orders.ts");
    expect(text).toContain("Totals an order.");
    // The listing is a way in, not an end in itself.
    expect(text).toContain("get_explanation");
  });

  it("counts correctly, singular and plural", () => {
    store(repo, "one", "a.ts", "First.");
    expect(renderListResult(runList(db, { repo }))).toContain(
      "1 explanation saved",
    );

    store(repo, "two", "b.ts", "Second.");
    expect(renderListResult(runList(db, { repo }))).toContain(
      "2 explanations saved",
    );
  });

  it("marks stale and anchored entries", () => {
    const row = store(repo, "processOrder", "src/orders.ts", "Totals.");
    setAnchor(db, row.id, "aabbccdd");
    markStale(db, { repo, file_path: "src/orders.ts", symbol: "processOrder" });

    const text = renderListResult(runList(db, { repo }));
    expect(text).toContain("(stale, anchored)");
  });

  it("calls out how many are stale, and what that means", () => {
    store(repo, "a", "a.ts", "One.");
    store(repo, "b", "b.ts", "Two.");
    markStale(db, { repo, file_path: "a.ts", symbol: "a" });

    const text = renderListResult(runList(db, { repo }));
    expect(text).toContain("1 is flagged stale");
    expect(text).toContain("refreshed");
  });

  it("says nothing about staleness when nothing is stale", () => {
    store(repo, "a", "a.ts", "One.");
    expect(renderListResult(runList(db, { repo }))).not.toContain("stale");
  });
});
