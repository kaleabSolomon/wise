import { z } from "zod";
import type { DB } from "../store/db.js";
import { markStale, clearStale } from "../store/queries.js";
import { normalizeLocator } from "../store/locator.js";
import { structuralHash } from "../code/hash.js";
import { locateForRow, resolveRow } from "./relocate.js";

export const getExplanationShape = {
  repo: z.string().min(1).describe("Absolute path to the repository root"),
  file: z
    .string()
    .min(1)
    .describe(
      "Path to the source file — relative to the repo root, or absolute",
    ),
  symbol: z
    .string()
    .min(1)
    .describe('Symbol to retrieve, e.g. "resolvePrice" or "Cart.total"'),
};

export type GetExplanationArgs = {
  [K in keyof typeof getExplanationShape]: z.infer<
    (typeof getExplanationShape)[K]
  >;
};

export type GetResult =
  | { status: "not_stored"; symbol: string }
  | { status: "fresh"; symbol: string; prose: string }
  | {
      status: "stale";
      symbol: string;
      oldProse: string;
      oldSnapshot: string;
      currentCode: string;
    }
  | {
      status: "relocate_failed";
      symbol: string;
      reason: "not_found" | "ambiguous";
      prose: string;
    }
  | { status: "outside_repo"; symbol: string; message: string };

/**
 * Core of `get_explanation`: fetch the stored row, re-read the symbol on disk,
 * and compare structural hashes. Fresh → return prose; stale → return the
 * materials the agent needs to refresh. The server never regenerates itself.
 */
export function runGet(db: DB, input: GetExplanationArgs): GetResult {
  const normalized = normalizeLocator(input);
  if (!normalized.ok) {
    return {
      status: "outside_repo",
      symbol: input.symbol,
      message: normalized.message,
    };
  }
  const { locator: loc, absPath } = normalized;

  // An anchored row can be found even when the caller's locator is out of date
  // — the code was renamed or moved since it was explained.
  const stored = resolveRow(db, loc, absPath);
  if (!stored) return { status: "not_stored", symbol: loc.symbol };

  // Likewise the code itself: if the stored name or path no longer resolves,
  // the anchor follows it and the row's locator is rewritten to match.
  const found = locateForRow(db, stored);
  if (!found.ok) {
    return {
      status: "relocate_failed",
      symbol: loc.symbol,
      reason: found.reason,
      prose: stored.prose,
    };
  }
  const { located, locator: at } = found;

  if (structuralHash(located.node) === stored.ast_hash) {
    // Structurally identical: any prior stale flag was a false alarm (cosmetic
    // change, or a commit that was later reverted). Self-heal it.
    if (stored.is_stale) clearStale(db, at);
    return { status: "fresh", symbol: at.symbol, prose: stored.prose };
  }

  if (!stored.is_stale) markStale(db, at);
  return {
    status: "stale",
    symbol: at.symbol,
    oldProse: stored.prose,
    oldSnapshot: stored.code_snapshot,
    currentCode: located.snapshot,
  };
}

/** Render a result as the text the reading agent sees. Pure; no MCP types. */
export function renderGetResult(r: GetResult): {
  text: string;
  isError: boolean;
} {
  switch (r.status) {
    case "not_stored":
      return {
        isError: false,
        text: `No explanation stored for "${r.symbol}". Explain it, then call save_explanation to remember it.`,
      };
    case "fresh":
      return { isError: false, text: r.prose };
    case "stale":
      return {
        isError: false,
        text: [
          `The explanation for "${r.symbol}" is STALE — the code changed since it was last explained.`,
          ``,
          `Regenerate it: describe what the code does now, and add a short delta of what changed since the previous explanation. Then call save_explanation with the refreshed prose.`,
          ``,
          `--- PREVIOUS EXPLANATION ---`,
          r.oldProse,
          ``,
          `--- CODE AT LAST EXPLANATION ---`,
          r.oldSnapshot,
          ``,
          `--- CURRENT CODE ---`,
          r.currentCode,
        ].join("\n"),
      };
    case "outside_repo":
      return { isError: true, text: r.message };
    case "relocate_failed":
      return {
        isError: false,
        text: [
          `Couldn't confidently re-locate "${r.symbol}" (${r.reason}) — it may have been renamed, moved, or removed.`,
          `Here is the last saved explanation, which may be out of date:`,
          ``,
          r.prose,
        ].join("\n"),
      };
    default: {
      const exhaustive: never = r;
      throw new Error(`unhandled get result: ${String(exhaustive)}`);
    }
  }
}
