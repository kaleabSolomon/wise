/**
 * In-code anchors: an opt-in marker the user's code carries so an explanation
 * survives a rename or a move.
 *
 *     // wise:7f3a9c2e
 *     export function processOrder(order: Order): Receipt {
 *
 * Wise never writes these — the agent does, on instruction, so the edit lands
 * in the user's normal review and the comment syntax is chosen by something
 * that knows the language. Wise only ever *finds* them, by plain substring
 * search for the token, which is why `#`, `--` and `<!-- -->` comments work
 * without a line of language-specific code.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories never worth scanning for an anchor. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "vendor",
  "target",
]);

/** Cap the non-git fallback scan so a huge tree can't stall a read. */
const MAX_SCAN_FILES = 5000;

export interface AnchorHit {
  /** Repo-relative, POSIX-separated — the same shape a locator stores. */
  file: string;
  /** 1-based line the marker sits on. */
  line: number;
}

/** A fresh anchor id. Short enough to read, wide enough not to collide. */
export function mintAnchorId(): string {
  return randomBytes(4).toString("hex");
}

/** The literal text searched for in source files. */
export function anchorToken(anchorId: string): string {
  return `wise:${anchorId}`;
}

/** Any wise anchor id appearing in a line of source. */
const ANCHOR_PATTERN = /wise:([0-9a-f]{8})\b/;

/** 1-based line of `anchorId` in this text, if present. */
export function findAnchorInText(
  text: string,
  anchorId: string,
): number | undefined {
  const token = anchorToken(anchorId);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(token)) return i + 1;
  }
  return undefined;
}

/** The anchor id on this exact line, if there is one. */
export function anchorIdOnLine(text: string, line: number): string | undefined {
  const match = ANCHOR_PATTERN.exec(text.split("\n")[line - 1] ?? "");
  return match?.[1];
}

/**
 * The anchor id marking the declaration that starts at `line`, if any — the
 * marker sits on one of the few lines above it, past any decorators or
 * attributes the declaration carries.
 */
export function anchorIdAbove(
  text: string,
  line: number,
  lookback = 4,
): string | undefined {
  const lines = text.split("\n");
  const from = Math.max(0, line - 1 - lookback);
  for (let i = line - 2; i >= from; i--) {
    const match = ANCHOR_PATTERN.exec(lines[i] ?? "");
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Read a file, returning undefined rather than throwing when it can't be. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Find an anchor anywhere in the repo. Tries `git grep` first — it is fast and
 * already knows what to ignore — and falls back to a bounded walk for repos
 * that aren't git repos (or when git isn't available).
 */
export function findAnchorInRepo(
  repo: string,
  anchorId: string,
): AnchorHit | undefined {
  return gitGrepAnchor(repo, anchorId) ?? scanForAnchor(repo, anchorId);
}

function gitGrepAnchor(repo: string, anchorId: string): AnchorHit | undefined {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "-C",
        repo,
        "grep",
        "--no-color",
        "-n", // line numbers
        "-I", // skip binary files
        "-F", // the token is a literal, not a pattern
        "--untracked", // a just-created file still counts
        anchorToken(anchorId),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // Exit code 1 simply means "no match"; anything else (not a repo, no git)
    // is equally a reason to fall through to the manual scan.
    return undefined;
  }

  // `path/to/file.ts:12:  // wise:7f3a9c2e`
  const first = out.split("\n").find((l) => l.trim().length > 0);
  if (first === undefined) return undefined;
  const match = /^(.*?):(\d+):/.exec(first);
  const file = match?.[1];
  const line = Number(match?.[2]);
  if (file === undefined || !Number.isFinite(line)) return undefined;
  return { file, line };
}

/** Walk a repo's source files, stopping early when `visit` returns true. */
function eachSourceFile(
  repo: string,
  visit: (relPath: string, text: string) => boolean,
): void {
  let budget = MAX_SCAN_FILES;

  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (budget <= 0) return false;
      const full = join(dir, entry);

      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        if (SKIP_DIRS.has(entry)) continue;
        if (walk(full)) return true;
        continue;
      }

      budget--;
      const text = readText(full);
      if (text === undefined) continue;
      if (visit(relative(repo, full).split(sep).join("/"), text)) return true;
    }
    return false;
  };

  walk(repo);
}

function scanForAnchor(repo: string, anchorId: string): AnchorHit | undefined {
  let hit: AnchorHit | undefined;
  eachSourceFile(repo, (file, text) => {
    const line = findAnchorInText(text, anchorId);
    if (line === undefined) return false;
    hit = { file, line };
    return true;
  });
  return hit;
}

/** One anchor occurrence in a file. */
export interface AnchorMatch {
  line: number;
  id: string;
}

/** Every anchor marker in a piece of source, in order. */
export function findAllAnchorsInText(text: string): AnchorMatch[] {
  const out: AnchorMatch[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = ANCHOR_PATTERN.exec(lines[i] ?? "");
    if (match?.[1]) out.push({ line: i + 1, id: match[1] });
  }
  return out;
}

/**
 * A line holding nothing but a marker, in any comment syntax — `// wise:id`,
 * `# wise:id`, `<!-- wise:id -->`. Anything with real content on it is left
 * alone: removing a marker must never take a line of the user's code with it.
 */
const STANDALONE_MARKER = /^[^A-Za-z0-9_]*wise:[0-9a-f]{8}[^A-Za-z0-9_]*$/;

export interface StripResult {
  text: string;
  /** Markers on their own line — these were removed. */
  removed: AnchorMatch[];
  /** Markers sharing a line with something else — left for the user. */
  skipped: AnchorMatch[];
}

/** Remove standalone marker lines, leaving every other line untouched. */
export function stripAnchorLines(text: string): StripResult {
  const lines = text.split("\n");
  const removed: AnchorMatch[] = [];
  const skipped: AnchorMatch[] = [];
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = ANCHOR_PATTERN.exec(line);
    const id = match?.[1];

    if (id !== undefined && STANDALONE_MARKER.test(line.trim())) {
      removed.push({ line: i + 1, id });
      continue;
    }
    if (id !== undefined) skipped.push({ line: i + 1, id });
    kept.push(line);
  }

  return { text: kept.join("\n"), removed, skipped };
}

/** Every file in the repo carrying at least one marker, repo-relative. */
export function findAnchorFiles(repo: string): string[] {
  const viaGit = gitGrepAnchorFiles(repo);
  if (viaGit !== undefined) return viaGit;

  const files: string[] = [];
  eachSourceFile(repo, (file, text) => {
    if (ANCHOR_PATTERN.test(text)) files.push(file);
    return false;
  });
  return files;
}

function gitGrepAnchorFiles(repo: string): string[] | undefined {
  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        repo,
        "grep",
        "--no-color",
        "-l",
        "-I",
        "-E",
        "--untracked",
        "wise:[0-9a-f]{8}",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\n").filter((l) => l.trim().length > 0);
  } catch (err) {
    // Exit 1 is git saying "searched, found nothing" — a definitive empty
    // answer worth trusting, rather than re-walking the whole tree by hand.
    // Any other failure (not a repo, no git) falls back to the manual scan.
    const status = (err as { status?: unknown }).status;
    return status === 1 ? [] : undefined;
  }
}
