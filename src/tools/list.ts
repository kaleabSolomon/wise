/**
 * `list_explanations`: what has been explained in this repo?
 *
 * The missing half of the loop. Saving works and retrieving works, but
 * retrieval only helps if you already know what to ask for — an agent opening
 * a repo has no way to discover that anything is stored at all. This makes
 * wise something that can surface itself rather than something you must
 * remember to query.
 *
 * A gist per entry, not the prose. A bare list of symbol names cannot answer
 * "is any of this relevant to what was just asked", but a dozen full
 * explanations would be tens of kilobytes of context. One line each is enough
 * to choose, and `get_explanation` remains the way to read one.
 */

import { z } from "zod";
import type { DB } from "../store/db.js";
import { listByRepo } from "../store/queries.js";
import { canonicalize } from "../store/locator.js";
import { firstParagraph } from "./summary.js";

/** Shorter than the hover's: a listing is scanned, not read. */
const GIST_LIMIT = 140;

export const listExplanationsShape = {
  repo: z.string().min(1).describe("Absolute path to the repository root"),
};

export type ListExplanationsArgs = {
  [K in keyof typeof listExplanationsShape]: z.infer<
    (typeof listExplanationsShape)[K]
  >;
};

export interface ListedExplanation {
  id: number;
  symbol: string;
  file: string;
  gist: string;
  is_stale: boolean;
  anchored: boolean;
}

export interface ListResult {
  repo: string;
  explanations: ListedExplanation[];
}

export function runList(db: DB, input: ListExplanationsArgs): ListResult {
  // Canonical, because that is how locators are stored; a repo spelled any
  // other way would silently list nothing. See store/locator.ts.
  const repo = canonicalize(input.repo);

  return {
    repo,
    explanations: listByRepo(db, repo).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      file: row.file_path,
      gist: firstParagraph(row.prose, GIST_LIMIT),
      is_stale: row.is_stale,
      anchored: row.anchored,
    })),
  };
}

/** Render for the reading agent. Pure; no MCP types. */
export function renderListResult(result: ListResult): string {
  if (result.explanations.length === 0) {
    return [
      `No explanations saved for ${result.repo} yet.`,
      `Explain something and call save_explanation to start one.`,
    ].join("\n");
  }

  const count = result.explanations.length;
  const lines = [
    `${count} explanation${count === 1 ? "" : "s"} saved for ${result.repo}, most recently updated first.`,
    `Call get_explanation with a symbol below to read one in full.`,
    ``,
  ];

  for (const entry of result.explanations) {
    const tags = [
      entry.is_stale ? "stale" : null,
      entry.anchored ? "anchored" : null,
    ]
      .filter((tag) => tag !== null)
      .join(", ");
    lines.push(`- ${entry.symbol} — ${entry.file}${tags ? ` (${tags})` : ""}`);
    // Indented so a multi-line gist stays visibly attached to its entry.
    if (entry.gist) lines.push(`    ${entry.gist.replace(/\n/g, "\n    ")}`);
  }

  const stale = result.explanations.filter((e) => e.is_stale).length;
  if (stale > 0) {
    lines.push(
      ``,
      `${stale} ${stale === 1 ? "is" : "are"} flagged stale: the code changed since it was explained. Reading one returns the old explanation alongside the old and current code so it can be refreshed.`,
    );
  }

  return lines.join("\n");
}
