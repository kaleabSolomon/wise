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
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export type DB = Database.Database;

/** Current schema version. Bump when adding a migration below. */
export const SCHEMA_VERSION = 1;

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
 * Open (creating if needed) the store and bring its schema up to date.
 * Idempotent: safe to call on every process start.
 */
export function openDb(dbPath: string = resolveDbPath()): DB {
  if (dbPath !== ":memory:") {
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
