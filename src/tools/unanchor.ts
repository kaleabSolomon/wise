/**
 * `wise unanchor` — take every marker back out of a repo.
 *
 * Opting in to anchors has to be reversible, or it isn't really opt-in. This
 * is the one place wise edits a user's files, and only ever to remove its own
 * traces: it runs as a dry run unless explicitly applied, and it will not
 * touch a line that holds anything besides the marker.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../store/db.js";
import { clearAnchorsForRepo, setAnchorsEnabled } from "../store/queries.js";
import { canonicalize } from "../store/locator.js";
import { findAnchorFiles, stripAnchorLines } from "../code/anchor.js";

export interface UnanchorFile {
  file: string;
  removed: number;
  /** Markers sharing a line with other content; left for the user to judge. */
  skipped: number;
}

export interface UnanchorReport {
  repo: string;
  applied: boolean;
  files: UnanchorFile[];
  totalRemoved: number;
  totalSkipped: number;
  clearedRows: number;
  message: string;
}

export function runUnanchor(
  db: DB,
  repoInput: string,
  options: { apply: boolean },
): UnanchorReport {
  const repo = canonicalize(repoInput);
  const files: UnanchorFile[] = [];

  for (const file of findAnchorFiles(repo)) {
    const path = join(repo, file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const result = stripAnchorLines(text);
    if (result.removed.length === 0 && result.skipped.length === 0) continue;

    if (options.apply && result.removed.length > 0) {
      writeFileSync(path, result.text);
    }
    files.push({
      file,
      removed: result.removed.length,
      skipped: result.skipped.length,
    });
  }

  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);
  const totalSkipped = files.reduce((n, f) => n + f.skipped, 0);

  // Clearing the ids and the repo setting together is what makes this a true
  // undo: nothing points at a marker any more, and no new one gets minted.
  let clearedRows = 0;
  if (options.apply) {
    clearedRows = clearAnchorsForRepo(db, repo);
    setAnchorsEnabled(db, repo, false);
  }

  return {
    repo,
    applied: options.apply,
    files,
    totalRemoved,
    totalSkipped,
    clearedRows,
    message: renderReport({
      repo,
      applied: options.apply,
      files,
      totalRemoved,
      totalSkipped,
      clearedRows,
    }),
  };
}

function renderReport(r: Omit<UnanchorReport, "message">): string {
  if (r.totalRemoved === 0 && r.totalSkipped === 0) {
    return `No wise anchors found in ${r.repo}.`;
  }

  const lines = r.files.map((f) => {
    const skipNote = f.skipped > 0 ? `, ${f.skipped} to remove by hand` : "";
    return `  ${f.file} — ${f.removed} marker(s)${skipNote}`;
  });

  const head = r.applied
    ? `Removed ${r.totalRemoved} anchor(s) from ${r.repo}:`
    : `Would remove ${r.totalRemoved} anchor(s) from ${r.repo} (dry run — pass --apply to do it):`;

  const tail: string[] = [];
  if (r.totalSkipped > 0) {
    tail.push(
      ``,
      `${r.totalSkipped} marker(s) share a line with other content and were left alone — remove those by hand.`,
    );
  }
  if (r.applied) {
    tail.push(
      ``,
      `Cleared ${r.clearedRows} stored anchor id(s) and turned anchors off for this repo. Explanations are unaffected and still resolve by name and path.`,
    );
  }

  return [head, ...lines, ...tail].join("\n");
}
