/**
 * Finding an explanation's code when the locator alone no longer does.
 *
 * A locator is an address, and addresses change: rename the symbol, move the
 * file, and the row is orphaned. An anchor is identity instead — a marker the
 * code carries — so these two helpers can follow the code and rewrite the
 * stored locator to match, rather than reporting a failure the user then has
 * to fix by hand.
 *
 * Neither does anything for an unanchored row: both fall straight through to
 * the by-name behaviour that predates anchors.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../store/db.js";
import {
  getByAnchor,
  getByLocator,
  relocateExplanation,
  type Explanation,
  type Locator,
} from "../store/queries.js";
import { locateAfterLine, locateInFile } from "../code/locate.js";
import type { LocatedSymbol } from "../code/locate.js";
import {
  anchorIdAbove,
  findAnchorInRepo,
  findAnchorInText,
} from "../code/anchor.js";

export type RowLocation =
  | {
      ok: true;
      located: LocatedSymbol;
      locator: Locator;
      /** What had to move for this to resolve. */
      healed: "none" | "symbol" | "file";
    }
  | { ok: false; reason: "not_found" | "ambiguous" };

function readIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored row for a requested locator.
 *
 * When the locator itself misses, the code at that spot may still carry an
 * anchor from before a rename — in which case the row is found by identity and
 * its locator updated to where the caller says the code now is.
 */
export function resolveRow(
  db: DB,
  loc: Locator,
  absPath: string,
): Explanation | undefined {
  const direct = getByLocator(db, loc);
  if (direct) return direct;

  const text = readIfPresent(absPath);
  if (text === undefined) return undefined;

  const located = locateInFile(absPath, loc.symbol);
  if (!located.ok) return undefined;

  const anchorId = anchorIdAbove(text, located.symbol.startLine);
  if (anchorId === undefined) return undefined;

  const row = getByAnchor(db, anchorId);
  if (!row) return undefined;
  if (row.repo !== loc.repo) return undefined; // same marker, different repo

  if (row.file_path === loc.file_path && row.symbol === loc.symbol) return row;
  relocateExplanation(db, row.id, {
    file_path: loc.file_path,
    symbol: loc.symbol,
  });
  return { ...row, file_path: loc.file_path, symbol: loc.symbol };
}

/**
 * Locate the code a row describes, following its anchor if the stored name or
 * path no longer resolves, and healing the row when it does.
 */
export function locateForRow(db: DB, row: Explanation): RowLocation {
  const at = (file_path: string, symbol: string): Locator => ({
    repo: row.repo,
    file_path,
    symbol,
  });

  const absPath = join(row.repo, row.file_path);
  const byName = existsSync(absPath)
    ? locateInFile(absPath, row.symbol)
    : ({ ok: false, reason: "not_found" } as const);

  if (byName.ok) {
    return {
      ok: true,
      located: byName.symbol,
      locator: at(row.file_path, row.symbol),
      healed: "none",
    };
  }

  const anchorId = row.anchor_id;
  if (anchorId === null) return { ok: false, reason: byName.reason };

  // Still in the same file, under a new name?
  const text = readIfPresent(absPath);
  const lineHere =
    text === undefined ? undefined : findAnchorInText(text, anchorId);
  if (lineHere !== undefined) {
    const found = locateAfterLine(absPath, lineHere);
    if (found.ok) {
      relocateExplanation(db, row.id, {
        file_path: row.file_path,
        symbol: found.symbol.name,
      });
      return {
        ok: true,
        located: found.symbol,
        locator: at(row.file_path, found.symbol.name),
        healed: "symbol",
      };
    }
  }

  // Otherwise the file itself moved — search the repo for the marker.
  const hit = findAnchorInRepo(row.repo, anchorId);
  if (hit === undefined) return { ok: false, reason: byName.reason };

  const movedPath = join(row.repo, hit.file);
  const found = locateAfterLine(movedPath, hit.line);
  if (!found.ok) return { ok: false, reason: found.reason };

  relocateExplanation(db, row.id, {
    file_path: hit.file,
    symbol: found.symbol.name,
  });
  return {
    ok: true,
    located: found.symbol,
    locator: at(hit.file, found.symbol.name),
    healed: "file",
  };
}
