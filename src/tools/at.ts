/**
 * "What is explained at this file and line?" — the lookup an editor hover asks.
 *
 * Two ways in, because wise only parses TypeScript and JavaScript:
 *
 *   - TS/JS: ts-morph resolves the declaration containing the cursor, so
 *     pointing anywhere inside a function resolves to that function.
 *   - Any other language: no parser, so the only thing wise knows precisely is
 *     where an anchor marker sits. Resolution is therefore limited to the
 *     marker's own line and the declaration line directly below it. Walking
 *     further up to "the nearest anchor above" would answer confidently with
 *     the wrong explanation as soon as an unanchored function sat below an
 *     anchored one, which is worse than answering nothing.
 *
 * Staleness comes from the stored flag rather than a fresh hash: a hover fires
 * constantly and should stay cheap. `get_explanation` remains the authority.
 */

import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../store/db.js";
import { getByAnchor, getByLocator } from "../store/queries.js";
import { normalizeLocator } from "../store/locator.js";
import { enclosingSymbolNames } from "../code/locate.js";
import { anchorIdAbove, anchorIdOnLine } from "../code/anchor.js";

/** Extensions ts-morph can parse; everything else resolves by anchor only. */
const PARSEABLE = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export interface AtQuery {
  repo: string;
  file: string;
  /** 1-based, as editors report it. */
  line: number;
}

export type AtResult =
  | { found: false }
  | {
      found: true;
      id: number;
      symbol: string;
      file: string;
      /** The whole explanation. */
      prose: string;
      /** The opening paragraph, for callers with no room for the whole thing. */
      summary: string;
      is_stale: boolean;
      /** How it resolved, which an editor may want to surface differently. */
      via: "symbol" | "anchor";
    };

const NOTHING: AtResult = { found: false };

/**
 * The opening paragraph of an explanation.
 *
 * A hover has room for a sentence or two; explanations here routinely run to
 * several hundred words, so handing the whole thing to a tooltip would bury
 * the editor. Leading headings are skipped because explanations often open
 * with a title (`## BitReader`) whose text says nothing on its own.
 *
 * The block keeps its own markdown, so a list stays a list rather than being
 * flattened into a run-on line.
 */
export function firstParagraph(prose: string, limit = 320): string {
  const blocks = prose
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const body = blocks.find((block) => !/^#{1,6}\s/.test(block)) ?? blocks[0];
  if (body === undefined) return "";
  if (body.length <= limit) return body;

  // Prefer a word boundary, but never cut back so far that little is left.
  const cut = body.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function readIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function explanationAt(db: DB, query: AtQuery): AtResult {
  // The symbol is unknown at this point — it is what we are resolving — so the
  // locator is normalized for its repo and path handling alone.
  const normalized = normalizeLocator({
    repo: query.repo,
    file: query.file,
    symbol: "",
  });
  if (!normalized.ok) return NOTHING;

  const { locator, absPath } = normalized;

  if (PARSEABLE.has(extensionOf(locator.file_path))) {
    // Innermost first, so an explained local wins over its enclosing
    // function, but a cursor in an ordinary function body still reaches it.
    for (const symbol of enclosingSymbolNames(absPath, query.line)) {
      const row = getByLocator(db, { ...locator, symbol });
      if (!row) continue;
      return {
        found: true,
        id: row.id,
        symbol: row.symbol,
        file: row.file_path,
        prose: row.prose,
        summary: firstParagraph(row.prose),
        is_stale: row.is_stale,
        via: "symbol",
      };
    }
    // Nothing under any enclosing name: the symbol may have been renamed since
    // it was explained, in which case its anchor still points at the right row.
  }

  const text = readIfPresent(absPath);
  if (text === undefined) return NOTHING;

  // The marker's own line, or the declaration line immediately below it.
  const anchorId =
    anchorIdOnLine(text, query.line) ?? anchorIdAbove(text, query.line, 1);
  if (anchorId === undefined) return NOTHING;

  const row = getByAnchor(db, anchorId);
  // An anchor is unique per store, so confirm it belongs to the repo asked
  // about before handing back someone else's explanation.
  if (!row || row.repo !== locator.repo) return NOTHING;

  return {
    found: true,
    id: row.id,
    symbol: row.symbol,
    file: row.file_path,
    prose: row.prose,
    summary: firstParagraph(row.prose),
    is_stale: row.is_stale,
    via: "anchor",
  };
}
