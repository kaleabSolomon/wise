/**
 * Turning in-code anchors on or off for one repository.
 *
 * The setting lives in wise's own store, keyed by canonical repo path — never
 * in the repo itself. A config file in the user's project would be exactly the
 * kind of trace wise exists to avoid, and a worse one than the anchors: it
 * would land even in a repo with no explanations in it.
 */

import { z } from "zod";
import type { DB } from "../store/db.js";
import { anchorsEnabled, setAnchorsEnabled } from "../store/queries.js";
import { canonicalize } from "../store/locator.js";

export const setAnchorsShape = {
  repo: z.string().min(1).describe("Absolute path to the repository root"),
  enabled: z
    .boolean()
    .describe(
      "true to mint an anchor for each newly saved explanation in this repo",
    ),
};

export type SetAnchorsArgs = {
  [K in keyof typeof setAnchorsShape]: z.infer<(typeof setAnchorsShape)[K]>;
};

export interface SetAnchorsResult {
  repo: string;
  enabled: boolean;
  message: string;
}

export function runSetAnchors(db: DB, input: SetAnchorsArgs): SetAnchorsResult {
  const repo = canonicalize(input.repo);
  setAnchorsEnabled(db, repo, input.enabled);

  const message = input.enabled
    ? [
        `In-code anchors are ON for ${repo}.`,
        `Each newly saved explanation now gets a short marker comment (e.g. "// wise:7f3a9c2e") to add above the symbol it explains, so the explanation survives renames and file moves.`,
        `Existing explanations pick one up the next time they are saved. Nothing is written to the repo by wise itself.`,
      ].join("\n")
    : [
        `In-code anchors are OFF for ${repo}.`,
        `No new markers will be suggested. Anchors already in the code keep working — delete those comments to remove them.`,
      ].join("\n");

  return { repo, enabled: input.enabled, message };
}

/** Current setting, for the CLI's read-only form. */
export function anchorsState(db: DB, repo: string): boolean {
  return anchorsEnabled(db, canonicalize(repo));
}
