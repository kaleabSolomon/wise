import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { rmSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { listExplanations, latestVersion } from "./queries.js";

describe("openDb — ephemeral-path warning", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created) {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(p + suffix, { force: true });
      }
    }
    created.length = 0;
    vi.restoreAllMocks();
  });

  it("warns when the store is under a temp directory", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = `/tmp/wise-ephemeral-test-${process.pid}.db`;
    created.push(path);

    openDb(path).close();

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("will not persist");
  });

  it("does not warn for a durable or in-memory store", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    openDb(":memory:").close();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("migration v1 -> v2 — locator canonicalization", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-mig-")));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  const dbPath = join(base, "store.db");

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /**
   * Undo everything later migrations added, so the file on disk really is the
   * shape a v1 build would have left behind. Winding `schema_version` back
   * alone isn't enough — the migrations would re-run against columns that
   * already exist.
   */
  function windBackToV1(db: ReturnType<typeof openDb>): void {
    db.exec(`DROP INDEX IF EXISTS idx_explanations_anchor;`);
    db.exec(`ALTER TABLE explanations DROP COLUMN anchor_id;`);
    db.exec(`DROP TABLE IF EXISTS repo_settings;`);
    db.prepare(`UPDATE schema_version SET version = 1`).run();
  }

  /**
   * Seed rows the way a pre-normalization build would have written them, then
   * wind the store back so reopening replays the migrations over them.
   */
  function seedV1Store(): void {
    const db = openDb(dbPath);
    const insert = db.prepare(
      `INSERT INTO explanations (repo, file_path, symbol, prose, code_snapshot, ast_hash, is_stale, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(`${repo}/`, "src/a.ts", "a", "prose a", "c", "h", 0, 100);
    insert.run(repo, "./src/b.ts", "b", "prose b", "c", "h", 0, 100);
    insert.run(
      repo,
      join(repo, "src", "c.ts"),
      "c",
      "prose c",
      "c",
      "h",
      0,
      100,
    );

    // Two spellings of one symbol, the second more recently updated.
    insert.run(repo, "src/d.ts", "d", "older d", "c1", "h1", 1, 100);
    const dup = insert.run(
      `${repo}/`,
      "./src/d.ts",
      "d",
      "newer d",
      "c2",
      "h2",
      0,
      200,
    );
    db.prepare(
      `INSERT INTO explanation_versions (explanation_id, prose, code_snapshot, ast_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      Number(dup.lastInsertRowid),
      "history of the duplicate",
      "c0",
      "h0",
      50,
    );

    windBackToV1(db);
    db.close();
  }

  it("rewrites every spelling to one canonical locator, merging duplicates", () => {
    seedV1Store();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const db = openDb(dbPath);
    const rows = listExplanations(db);

    // Four distinct symbols; the two spellings of "d" collapsed into one row.
    expect(rows).toHaveLength(4);
    expect(
      rows.map((r) => `${r.repo}|${r.file_path}|${r.symbol}`).sort(),
    ).toEqual([
      `${repo}|src/a.ts|a`,
      `${repo}|src/b.ts|b`,
      `${repo}|src/c.ts|c`,
      `${repo}|src/d.ts|d`,
    ]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("merged 1 duplicate");

    // The more recent generation survives as current...
    const d = rows.find((r) => r.symbol === "d");
    expect(d).toBeDefined();
    if (!d) return;
    const stored = db
      .prepare(`SELECT prose, is_stale FROM explanations WHERE id = ?`)
      .get(d.id) as { prose: string; is_stale: number };
    expect(stored.prose).toBe("newer d");
    // ...and a stale flag on either spelling is kept: a false one self-heals on
    // the next read, a lost one hides a real change.
    expect(stored.is_stale).toBe(1);

    // Nothing from either row's history was dropped on the way through.
    const proses = db
      .prepare(
        `SELECT prose FROM explanation_versions WHERE explanation_id = ? ORDER BY created_at`,
      )
      .all(d.id) as Array<{ prose: string }>;
    expect(proses.map((v) => v.prose)).toEqual([
      "history of the duplicate",
      "older d",
    ]);
    expect(latestVersion(db, d.id)?.prose).toBe("older d");

    db.close();
  });

  it("is a no-op on a store whose locators are already canonical", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openDb(dbPath);
    expect(listExplanations(db)).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
    db.close();
  });
});
