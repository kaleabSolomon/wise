import { z } from "zod";
import type { DB } from "../store/db.js";
import {
  anchorsEnabled,
  saveExplanation,
  setAnchor,
} from "../store/queries.js";
import { normalizeLocator } from "../store/locator.js";
import { locateInFile } from "../code/locate.js";
import { structuralHash } from "../code/hash.js";
import { anchorToken, mintAnchorId } from "../code/anchor.js";
import { resolveRow } from "./relocate.js";

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
  | {
      ok: true;
      id: number;
      message: string;
      /** Set only when this save minted a new anchor for the agent to place. */
      anchor?: { id: string; token: string };
    }
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

  // Resolving first lets an anchored row that has since been renamed or moved
  // be updated in place, instead of the save landing as a second row for code
  // that already has an explanation.
  const existing = resolveRow(db, locator, absPath);

  const row = saveExplanation(db, {
    ...locator,
    prose: input.prose,
    code_snapshot: located.symbol.snapshot,
    ast_hash: structuralHash(located.symbol.node),
  });

  const saved = `Saved explanation for ${locator.symbol} (${located.symbol.kind}).`;

  // Mint at most once per explanation: `anchor_id` is never cleared, so a user
  // who later deletes the comment is not asked to put it back.
  const wantsAnchor =
    (existing?.anchor_id ?? null) === null && anchorsEnabled(db, locator.repo);
  if (!wantsAnchor) return { ok: true, id: row.id, message: saved };

  const anchorId = mintAnchorId();
  setAnchor(db, row.id, anchorId);
  const token = anchorToken(anchorId);

  return {
    ok: true,
    id: row.id,
    anchor: { id: anchorId, token },
    message: [
      saved,
      ``,
      `This repo has anchors enabled. Add a comment containing "${token}" on the line directly above ${locator.symbol} in ${locator.file_path}, using that file's comment syntax — for example:`,
      ``,
      `    // ${token}`,
      ``,
      `The anchor lets wise follow this symbol if it is renamed or moved. It is optional: delete the comment whenever you like and wise falls back to matching by name and path.`,
    ].join("\n"),
  };
}
