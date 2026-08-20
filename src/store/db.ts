/**
 * SQLite connection + schema.
 *
 * The store is a single SQLite file in `~/.wise`, living entirely outside any
 * repo. This module owns three things:
 *   - resolving where the store lives (with env overrides for tests/isolation),
 *   - opening/creating the connection,
 *   - applying the schema via a small forward-only migration runner.
 *
 * It knows nothing about explanations as a concept — that's `queries.ts`. Here
 * we only guarantee an open connection whose schema is at `SCHEMA_VERSION`.
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { normalizeLocator } from "./locator.js";

export type DB = Database.Database;

/** Current schema version. Bump when adding a migration below. */
export const SCHEMA_VERSION = 2;

/**
 * The directory that holds the store. Defaults to `~/.wise`; overridable with
 * `WISE_HOME` so tests and sandboxes never touch the real store.
 */
export function wiseHome(): string {
  const override = process.env["WISE_HOME"];
  return override && override.length > 0 ? override : join(homedir(), ".wise");
}

/**
 * Absolute path to the SQLite file. `WISE_DB_PATH` overrides it wholesale —
 * pass `:memory:` there for a throwaway in-memory store in tests.
 */
export function resolveDbPath(): string {
  const override = process.env["WISE_DB_PATH"];
  if (override && override.length > 0) return override;
  return join(wiseHome(), "wise.db");
}

/**
 * Warn (on stderr, never stdout — that's the MCP channel) when the store sits
 * somewhere the OS reaps, e.g. `/tmp`. Silent data loss is the worst outcome;
 * a loud warning turns it into an obvious misconfiguration.
 */
function warnIfEphemeral(dbPath: string): void {
  const abs = resolve(dbPath);
  if (/^\/(private\/)?tmp\//.test(abs) || /^\/var\/tmp\//.test(abs)) {
    console.error(
      `wise: WARNING — the store at ${abs} is under a temporary directory the OS clears (reboots / periodic cleanup). Data will not persist. Set WISE_DB_PATH to a durable path (e.g. under your home directory).`,
    );
  }
}

/**
 * Open (creating if needed) the store and bring its schema up to date.
 * Idempotent: safe to call on every process start.
 */
export function openDb(dbPath: string = resolveDbPath()): DB {
  if (dbPath !== ":memory:") {
    warnIfEphemeral(dbPath);
    // The store dir may not exist yet on first run.
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  // WAL gives us concurrent reads (the viewer) alongside writes (the server),
  // which matters once the opt-in post-commit hook writes out-of-band.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

/**
 * Forward-only migrations. Each entry moves the schema from version `i` to
 * `i + 1`; we run every one whose target exceeds the store's current version,
 * inside a single transaction so a partial upgrade can never be observed.
 */
const MIGRATIONS: ReadonlyArray<(db: DB) => void> = [
  // v0 -> v1: initial schema.
  (db) => {
    db.exec(`
      CREATE TABLE explanations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Locator: how a row maps back to the code it describes.
        repo          TEXT NOT NULL,   -- repo root path (or identifier)
        file_path     TEXT NOT NULL,   -- path to the file, relative to repo
        symbol        TEXT NOT NULL,   -- symbol name within the file

        -- The current explanation + the code it was written against.
        prose         TEXT NOT NULL,   -- human-language markdown (display-only)
        code_snapshot TEXT NOT NULL,   -- symbol's source text at save time
        ast_hash      TEXT NOT NULL,   -- structural hash; drives staleness

        -- Staleness flag. Set by check-on-read or the opt-in post-commit hook;
        -- cleared when a fresh explanation is saved.
        is_stale      INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),

        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),

        -- One explanation per symbol per file per repo.
        UNIQUE (repo, file_path, symbol)
      );
    `);
    // Read path looks up by locator; keep it fast as the store grows.
    db.exec(
      `CREATE INDEX idx_explanations_locator ON explanations (repo, file_path, symbol);`,
    );

    // Append-only history. On each save, the outgoing generation is pushed here
    // before `explanations` is overwritten, so nothing is ever lost and a
    // refresh delta is just "current row vs the latest version row."
    db.exec(`
      CREATE TABLE explanation_versions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        explanation_id INTEGER NOT NULL
                         REFERENCES explanations(id) ON DELETE CASCADE,

        -- Snapshot of one past generation (mirrors the columns above).
        prose          TEXT NOT NULL,
        code_snapshot  TEXT NOT NULL,
        ast_hash       TEXT NOT NULL,

        -- When this generation was superseded (i.e. pushed into history).
        created_at     INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    // History is always read newest-first for a single explanation.
    db.exec(
      `CREATE INDEX idx_versions_explanation ON explanation_versions (explanation_id, created_at DESC);`,
    );
  },

  // v1 -> v2: canonicalize every stored locator.
  //
  // Locators used to be stored exactly as the caller spelled them, so one
  // symbol could occupy several rows — `src/a.ts`, `./src/a.ts`, an absolute
  // path, a repo with a trailing slash — and a differently-spelled read would
  // find none of them. Rewrite each row into canonical form; where two rows
  // collapse onto the same locator, merge them rather than discard either.
  (db) => {
    interface Generation {
      id: number;
      prose: string;
      code_snapshot: string;
      ast_hash: string;
      is_stale: number;
      updated_at: number;
    }
    interface Row extends Generation {
      repo: string;
      file_path: string;
      symbol: string;
    }

    const rows = db
      .prepare(
        `SELECT id, repo, file_path, symbol, prose, code_snapshot, ast_hash, is_stale, updated_at
         FROM explanations`,
      )
      .all() as Row[];

    const twinAt = db.prepare(
      `SELECT id, prose, code_snapshot, ast_hash, is_stale, updated_at FROM explanations
       WHERE repo = ? AND file_path = ? AND symbol = ? AND id != ?`,
    );
    const rewrite = db.prepare(
      `UPDATE explanations SET repo = ?, file_path = ?, symbol = ? WHERE id = ?`,
    );
    const addVersion = db.prepare(
      `INSERT INTO explanation_versions (explanation_id, prose, code_snapshot, ast_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const reparentVersions = db.prepare(
      `UPDATE explanation_versions SET explanation_id = ? WHERE explanation_id = ?`,
    );
    const setCurrent = db.prepare(
      `UPDATE explanations
       SET prose = ?, code_snapshot = ?, ast_hash = ?, is_stale = ?, updated_at = ?
       WHERE id = ?`,
    );
    const dropRow = db.prepare(`DELETE FROM explanations WHERE id = ?`);

    let rewritten = 0;
    let merged = 0;

    for (const row of rows) {
      const normalized = normalizeLocator({
        repo: row.repo,
        file: row.file_path,
        symbol: row.symbol,
      });
      // A locator we can't make sense of (one already pointing outside its
      // repo) is left exactly as it was: an untouched row beats a guessed one.
      if (!normalized.ok) continue;

      const { repo, file_path, symbol } = normalized.locator;
      if (
        repo === row.repo &&
        file_path === row.file_path &&
        symbol === row.symbol
      ) {
        continue;
      }

      const twin = twinAt.get(repo, file_path, symbol, row.id) as
        Generation | undefined;
      if (!twin) {
        rewrite.run(repo, file_path, symbol, row.id);
        rewritten++;
        continue;
      }

      // Two spellings of one symbol. Keep the twin's row, let the more recently
      // updated generation be the current one, and push the other into history
      // — along with the losing row's own versions, re-parented first so the FK
      // cascade on delete can't take them with it.
      const [newer, older]: [Generation, Generation] =
        row.updated_at > twin.updated_at ? [row, twin] : [twin, row];
      addVersion.run(
        twin.id,
        older.prose,
        older.code_snapshot,
        older.ast_hash,
        older.updated_at,
      );
      reparentVersions.run(twin.id, row.id);
      setCurrent.run(
        newer.prose,
        newer.code_snapshot,
        newer.ast_hash,
        // Stale wins: a false flag self-heals on the next read, a missing one
        // silently hides a change.
        row.is_stale === 1 || twin.is_stale === 1 ? 1 : 0,
        newer.updated_at,
        twin.id,
      );
      dropRow.run(row.id);
      merged++;
    }

    if (rewritten > 0 || merged > 0) {
      const mergeNote = merged > 0 ? `, merged ${merged} duplicate(s)` : "";
      console.error(
        `wise: normalized ${rewritten} explanation locator(s)${mergeNote}.`,
      );
    }
  },
];

function migrate(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`,
  );

  const row = db
    .prepare(`SELECT version FROM schema_version LIMIT 1;`)
    .get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  if (current > MIGRATIONS.length) {
    // The store was written by a newer build than this one.
    throw new Error(
      `wise store schema is v${current}, but this build only understands up to v${MIGRATIONS.length}. Upgrade wise.`,
    );
  }
  if (current === MIGRATIONS.length) return; // already current

  const run = db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) throw new Error(`missing migration ${v}`);
      migration(db);
    }
    // Collapse to a single row holding the new version.
    db.exec(`DELETE FROM schema_version;`);
    db.prepare(`INSERT INTO schema_version (version) VALUES (?);`).run(
      MIGRATIONS.length,
    );
  });
  run();
}
