import type { DB } from "./db.js";

export interface Locator {
  repo: string;
  file_path: string;
  symbol: string;
}

export interface Explanation extends Locator {
  id: number;
  prose: string;
  code_snapshot: string;
  ast_hash: string;
  is_stale: boolean;
  created_at: number;
  updated_at: number;
}

export interface Version {
  id: number;
  explanation_id: number;
  prose: string;
  code_snapshot: string;
  ast_hash: string;
  created_at: number;
}

export interface SaveInput extends Locator {
  prose: string;
  code_snapshot: string;
  ast_hash: string;
}

/** Row exactly as SQLite returns it — `is_stale` is 0/1 here, not a boolean. */
interface ExplanationRow extends Locator {
  id: number;
  prose: string;
  code_snapshot: string;
  ast_hash: string;
  is_stale: number;
  created_at: number;
  updated_at: number;
}

function toExplanation(row: ExplanationRow): Explanation {
  return { ...row, is_stale: row.is_stale === 1 };
}

export function getByLocator(db: DB, loc: Locator): Explanation | undefined {
  const row = db
    .prepare(
      `SELECT * FROM explanations WHERE repo = ? AND file_path = ? AND symbol = ?`,
    )
    .get(loc.repo, loc.file_path, loc.symbol) as ExplanationRow | undefined;
  return row ? toExplanation(row) : undefined;
}

export function getById(db: DB, id: number): Explanation | undefined {
  const row = db.prepare(`SELECT * FROM explanations WHERE id = ?`).get(id) as
    ExplanationRow | undefined;
  return row ? toExplanation(row) : undefined;
}

function mustGetById(db: DB, id: number): Explanation {
  const row = getById(db, id);
  if (!row) {
    throw new Error(`explanation ${id} not found immediately after write`);
  }
  return row;
}

/**
 * Insert a new explanation, or overwrite the one at this locator. On overwrite
 * the outgoing generation is pushed into history and the stale flag is cleared,
 * all in one transaction.
 */
export function saveExplanation(db: DB, input: SaveInput): Explanation {
  const tx = db.transaction((): Explanation => {
    const existing = getByLocator(db, input);

    if (existing) {
      db.prepare(
        `INSERT INTO explanation_versions (explanation_id, prose, code_snapshot, ast_hash)
         VALUES (?, ?, ?, ?)`,
      ).run(
        existing.id,
        existing.prose,
        existing.code_snapshot,
        existing.ast_hash,
      );
      db.prepare(
        `UPDATE explanations
         SET prose = ?, code_snapshot = ?, ast_hash = ?, is_stale = 0, updated_at = unixepoch()
         WHERE id = ?`,
      ).run(input.prose, input.code_snapshot, input.ast_hash, existing.id);
      return mustGetById(db, existing.id);
    }

    const info = db
      .prepare(
        `INSERT INTO explanations (repo, file_path, symbol, prose, code_snapshot, ast_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repo,
        input.file_path,
        input.symbol,
        input.prose,
        input.code_snapshot,
        input.ast_hash,
      );
    return mustGetById(db, Number(info.lastInsertRowid));
  });

  return tx();
}

export function markStale(db: DB, loc: Locator): boolean {
  return setStale(db, loc, 1);
}

export function clearStale(db: DB, loc: Locator): boolean {
  return setStale(db, loc, 0);
}

function setStale(db: DB, loc: Locator, value: 0 | 1): boolean {
  const info = db
    .prepare(
      `UPDATE explanations SET is_stale = ? WHERE repo = ? AND file_path = ? AND symbol = ?`,
    )
    .run(value, loc.repo, loc.file_path, loc.symbol);
  return info.changes > 0;
}

/** Most recent past generation — the other half of a refresh delta. */
export function latestVersion(
  db: DB,
  explanationId: number,
): Version | undefined {
  return db
    .prepare(
      `SELECT * FROM explanation_versions
       WHERE explanation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(explanationId) as Version | undefined;
}
