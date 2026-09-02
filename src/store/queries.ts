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
  /** Opt-in in-code marker tying this row to the code; NULL when unanchored. */
  anchor_id: string | null;
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
  anchor_id: string | null;
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

/** Delete an explanation and (via FK cascade) its version history. */
export function deleteExplanation(db: DB, id: number): boolean {
  return (
    db.prepare(`DELETE FROM explanations WHERE id = ?`).run(id).changes > 0
  );
}

function setStale(db: DB, loc: Locator, value: 0 | 1): boolean {
  const info = db
    .prepare(
      `UPDATE explanations SET is_stale = ? WHERE repo = ? AND file_path = ? AND symbol = ?`,
    )
    .run(value, loc.repo, loc.file_path, loc.symbol);
  return info.changes > 0;
}

/**
 * Coarsely flag every explanation in `repo` whose file changed. Used by the
 * post-commit hook: it flags by file, and check-on-read later confirms (and
 * self-heals) via the structural hash. Returns the number of rows flagged.
 */
export function markStaleByFiles(
  db: DB,
  repo: string,
  files: string[],
): number {
  if (files.length === 0) return 0;
  const placeholders = files.map(() => "?").join(", ");
  const info = db
    .prepare(
      `UPDATE explanations SET is_stale = 1 WHERE repo = ? AND file_path IN (${placeholders})`,
    )
    .run(repo, ...files);
  return info.changes;
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

export interface ExplanationSummary extends Locator {
  id: number;
  is_stale: boolean;
  /** Whether this row carries an anchor. Cheap: no file is read for a list. */
  anchored: boolean;
  updated_at: number;
}

/** Lightweight listing for the viewer — no prose or snapshots. Newest first. */
export function listExplanations(db: DB): ExplanationSummary[] {
  const rows = db
    .prepare(
      `SELECT id, repo, file_path, symbol, is_stale,
              anchor_id IS NOT NULL AS anchored, updated_at
       FROM explanations ORDER BY updated_at DESC, id DESC`,
    )
    .all() as Array<
    Omit<ExplanationSummary, "is_stale" | "anchored"> & {
      is_stale: number;
      anchored: number;
    }
  >;
  return rows.map((r) => ({
    ...r,
    is_stale: r.is_stale === 1,
    anchored: r.anchored === 1,
  }));
}

/** Look an explanation up by its in-code anchor, wherever the code now lives. */
export function getByAnchor(db: DB, anchorId: string): Explanation | undefined {
  const row = db
    .prepare(`SELECT * FROM explanations WHERE anchor_id = ?`)
    .get(anchorId) as ExplanationRow | undefined;
  return row ? toExplanation(row) : undefined;
}

export function setAnchor(db: DB, id: number, anchorId: string): void {
  db.prepare(`UPDATE explanations SET anchor_id = ? WHERE id = ?`).run(
    anchorId,
    id,
  );
}

/**
 * Point an existing row at where its code lives now. Used when an anchor is
 * found under a new name or in a new file — the explanation is the same, only
 * its address moved.
 */
export function relocateExplanation(
  db: DB,
  id: number,
  to: { file_path: string; symbol: string },
): void {
  db.prepare(
    `UPDATE explanations SET file_path = ?, symbol = ? WHERE id = ?`,
  ).run(to.file_path, to.symbol, id);
}

/** Whether this repo mints anchors for newly saved explanations. */
export function anchorsEnabled(db: DB, repo: string): boolean {
  const row = db
    .prepare(`SELECT anchors_enabled FROM repo_settings WHERE repo = ?`)
    .get(repo) as { anchors_enabled: number } | undefined;
  return row?.anchors_enabled === 1;
}

export function setAnchorsEnabled(
  db: DB,
  repo: string,
  enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO repo_settings (repo, anchors_enabled) VALUES (?, ?)
     ON CONFLICT (repo) DO UPDATE
       SET anchors_enabled = excluded.anchors_enabled, updated_at = unixepoch()`,
  ).run(repo, enabled ? 1 : 0);
}

/** Forget every anchor id in one repo. Returns how many rows were cleared. */
export function clearAnchorsForRepo(db: DB, repo: string): number {
  return db
    .prepare(
      `UPDATE explanations SET anchor_id = NULL
       WHERE repo = ? AND anchor_id IS NOT NULL`,
    )
    .run(repo).changes;
}
