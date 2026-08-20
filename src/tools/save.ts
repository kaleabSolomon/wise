import { z } from "zod";
import type { DB } from "../store/db.js";
import { saveExplanation } from "../store/queries.js";
import { normalizeLocator } from "../store/locator.js";
import { locateInFile } from "../code/locate.js";
import { structuralHash } from "../code/hash.js";

export const saveExplanationShape = {
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
    .describe('Symbol to explain, e.g. "resolvePrice" or "Cart.total"'),
  prose: z
    .string()
    .min(1)
    .describe("The human-language explanation, as markdown"),
};

export type SaveExplanationArgs = {
  [K in keyof typeof saveExplanationShape]: z.infer<
    (typeof saveExplanationShape)[K]
  >;
};

export type SaveResult =
  | { ok: true; id: number; message: string }
  | {
      ok: false;
      error: "not_found" | "ambiguous" | "outside_repo";
      message: string;
    };

/**
 * Core of `save_explanation`: locate the symbol on disk, snapshot + hash its
 * current code, and persist the prose alongside. No MCP concerns here.
 */
export function runSave(db: DB, input: SaveExplanationArgs): SaveResult {
  const normalized = normalizeLocator(input);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error, message: normalized.message };
  }
  const { locator, absPath } = normalized;

  const located = locateInFile(absPath, locator.symbol);
  if (!located.ok) {
    if (located.reason === "not_found") {
      return {
        ok: false,
        error: "not_found",
        message: `Symbol "${locator.symbol}" not found in ${locator.file_path}.`,
      };
    }
    return {
      ok: false,
      error: "ambiguous",
      message: `Symbol "${locator.symbol}" matches ${located.count} declarations in ${locator.file_path}; qualify it (e.g. "Class.method").`,
    };
  }

  const row = saveExplanation(db, {
    ...locator,
    prose: input.prose,
    code_snapshot: located.symbol.snapshot,
    ast_hash: structuralHash(located.symbol.node),
  });

  return {
    ok: true,
    id: row.id,
    message: `Saved explanation for ${locator.symbol} (${located.symbol.kind}).`,
  };
}
