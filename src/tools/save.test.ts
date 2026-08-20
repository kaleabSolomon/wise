import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import { getByLocator } from "../store/queries.js";
import { runSave } from "./save.js";

const SRC = `export function resolvePrice(base: number): number {
  return base * 2;
}

function dup() {}
const dup = 1;
`;

// Canonical form: on macOS `tmpdir()` sits under the `/var` -> `/private/var`
// symlink, and stored locators are always canonical (see store/locator.ts).
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-save-")));
writeFileSync(join(repo, "pricing.ts"), SRC);
afterAll(() => rmSync(repo, { recursive: true, force: true }));

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("runSave", () => {
  it("locates, snapshots, hashes, and stores an explanation", () => {
    const result = runSave(db, {
      repo,
      file: "pricing.ts",
      symbol: "resolvePrice",
      prose: "Doubles the base price.",
    });
    expect(result.ok).toBe(true);

    const stored = getByLocator(db, {
      repo,
      file_path: "pricing.ts",
      symbol: "resolvePrice",
    });
    expect(stored?.prose).toBe("Doubles the base price.");
    expect(stored?.code_snapshot).toContain("return base * 2;");
    expect(stored?.ast_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.is_stale).toBe(false);
  });

  it("re-saving overwrites the prose in place", () => {
    const args = {
      repo,
      file: "pricing.ts",
      symbol: "resolvePrice",
      prose: "first",
    };
    runSave(db, args);
    runSave(db, { ...args, prose: "second" });

    const stored = getByLocator(db, {
      repo,
      file_path: "pricing.ts",
      symbol: "resolvePrice",
    });
    expect(stored?.prose).toBe("second");
    expect(db.prepare("SELECT COUNT(*) c FROM explanations").get()).toEqual({
      c: 1,
    });
  });

  it("reports not_found for a missing symbol", () => {
    const result = runSave(db, {
      repo,
      file: "pricing.ts",
      symbol: "ghost",
      prose: "x",
    });
    expect(result).toMatchObject({ ok: false, error: "not_found" });
  });

  it("reports ambiguous for a name with multiple declarations", () => {
    const result = runSave(db, {
      repo,
      file: "pricing.ts",
      symbol: "dup",
      prose: "x",
    });
    expect(result).toMatchObject({ ok: false, error: "ambiguous" });
  });
});
