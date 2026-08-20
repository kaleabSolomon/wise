/**
 * Locator normalization.
 *
 * A locator (repo + file path + symbol) does two jobs: it says where to read
 * the code from on disk, and it is the key of an explanation row in the store.
 * Path resolution is forgiving — `/a/b/`, `./b`, an absolute file path and a
 * symlinked parent all reach the same file — but SQLite's key comparison is
 * exact. Without one canonical spelling the two jobs disagree: the file is
 * found, the row is missed, and a *second* row is written for the same symbol.
 *
 * So every read and write of a locator comes through here first. The path used
 * to read the file is then, by construction, the path that keys the row.
 */

import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Locator } from "./queries.js";

export interface LocatorInput {
  repo: string;
  file: string;
  symbol: string;
}

export type NormalizeResult =
  | { ok: true; locator: Locator; absPath: string }
  | { ok: false; error: "outside_repo"; message: string };

/**
 * Canonical absolute form of a path: symlinks collapsed and, on
 * case-insensitive filesystems, the real on-disk capitalization restored.
 *
 * `realpathSync.native` rather than `realpathSync` is deliberate. The JS
 * implementation resolves symlinks but leaves `casetest` spelled `casetest`
 * when the directory on disk is `CaseTest` — which is precisely the duplicate
 * key this function exists to prevent. Deferring to the OS also keeps us
 * correct on case-*sensitive* filesystems, where those really are two paths.
 *
 * Paths that don't exist yet still normalize: we canonicalize the deepest
 * ancestor that does exist and re-attach the rest. A locator whose file has
 * since been deleted or moved must still key the row that describes it.
 */
export function canonicalize(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    // `dirname` is a fixed point at the filesystem root — stop, don't recur.
    return parent === abs ? abs : join(canonicalize(parent), basename(abs));
  }
}

/** True when `rel` — the output of `path.relative` — escapes its base. */
function escapesBase(rel: string): boolean {
  return (
    rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  );
}

/**
 * Rewrite a caller-supplied locator into its one canonical form, and hand back
 * the absolute path that goes with it so callers never re-derive it themselves.
 *
 * Accepts `file` either relative to the repo or as an absolute path, and
 * rejects anything that lands outside the repo — previously such a locator was
 * stored happily and then never matched anything again.
 */
export function normalizeLocator(input: LocatorInput): NormalizeResult {
  const repo = canonicalize(input.repo);
  const requested = isAbsolute(input.file)
    ? input.file
    : join(repo, input.file);

  // Prefer the canonical path: it is what git reports for changed files, which
  // is what the post-commit hook flags by. But a symlink *inside* a repo points
  // out of it by definition, and refusing to explain such a file would be worse
  // than keeping its in-repo path — so fall back to the lexical resolution and
  // reject only when both land outside.
  const canonical = canonicalize(requested);
  const lexical = resolve(requested);
  const absPath = !escapesBase(relative(repo, canonical))
    ? canonical
    : !escapesBase(relative(repo, lexical))
      ? lexical
      : undefined;

  if (absPath === undefined) {
    return {
      ok: false,
      error: "outside_repo",
      message: `"${input.file}" does not resolve to a file inside ${repo}. Pass a path within the repository.`,
    };
  }
  const rel = relative(repo, absPath);

  return {
    ok: true,
    locator: {
      repo,
      // POSIX separators always: it keeps a locator written on Windows equal to
      // one written anywhere else, and matches how git reports changed paths —
      // which is what the post-commit hook flags by.
      file_path: rel.split(sep).join("/"),
      symbol: input.symbol.trim(),
    },
    absPath,
  };
}
