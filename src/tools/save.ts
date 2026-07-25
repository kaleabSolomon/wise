import { resolve } from "node:path";
import { z } from "zod";
import type { DB } from "../store/db.js";
import { saveExplanation } from "../store/queries.js";
import { locateInFile } from "../code/locate.js";
import { structuralHash } from "../code/hash.js";

export const saveExplanationShape = {
  repo: z.string().min(1).describe("Absolute path to the repository root"),
  file: z
    .string()
    .min(1)
    .describe("Path to the source file, relative to the repo root"),
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
  | { ok: false; error: "not_found" | "ambiguous"; message: string };

/**
 * Core of `save_explanation`: locate the symbol on disk, snapshot + hash its
 * current code, and persist the prose alongside. No MCP concerns here.
 */
export function runSave(db: DB, input: SaveExplanationArgs): SaveResult {
  const absPath = resolve(input.repo, input.file);
  const located = locateInFile(absPath, input.symbol);

  if (!located.ok) {
    if (located.reason === "not_found") {
      return {
        ok: false,
        error: "not_found",
        message: `Symbol "${input.symbol}" not found in ${input.file}.`,
      };
    }
    return {
      ok: false,
      error: "ambiguous",
      message: `Symbol "${input.symbol}" matches ${located.count} declarations in ${input.file}; qualify it (e.g. "Class.method").`,
    };
  }

  const row = saveExplanation(db, {
    repo: input.repo,
    file_path: input.file,
    symbol: input.symbol,
    prose: input.prose,
    code_snapshot: located.symbol.snapshot,
    ast_hash: structuralHash(located.symbol.node),
  });

  return {
    ok: true,
    id: row.id,
    message: `Saved explanation for ${input.symbol} (${located.symbol.kind}).`,
  };
}
