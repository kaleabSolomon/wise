import { execFileSync } from "node:child_process";
import type { DB } from "../store/db.js";
import { markStaleByFiles } from "../store/queries.js";

/**
 * Files touched by the repo's most recent commit, as paths relative to the repo
 * root. `--root` makes the very first commit list its files too.
 */
export function changedFilesInHead(repo: string): string[] {
  const out = execFileSync(
    "git",
    [
      "-C",
      repo,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--root",
      "HEAD",
    ],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Flag stale every stored explanation whose file changed in the last commit. */
export function flagStaleForHead(
  db: DB,
  repo: string,
): { files: string[]; flagged: number } {
  const files = changedFilesInHead(repo);
  return { files, flagged: markStaleByFiles(db, repo, files) };
}
