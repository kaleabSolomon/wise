import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db.js";
import { saveExplanation, getByLocator } from "../store/queries.js";
import { changedFilesInHead, flagStaleForHead } from "./flag.js";

const dirs: string[] = [];

function newGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wise-hook-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", dir]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  return dir;
}

function commit(dir: string, file: string, contents: string) {
  writeFileSync(join(dir, file), contents);
  execFileSync("git", ["-C", dir, "add", file]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", `edit ${file}`]);
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("changedFilesInHead", () => {
  it("lists files from the latest commit, including the root commit", () => {
    const dir = newGitRepo();
    commit(dir, "a.ts", "export const a = 1;\n");
    expect(changedFilesInHead(dir)).toEqual(["a.ts"]);

    commit(dir, "b.ts", "export const b = 2;\n");
    expect(changedFilesInHead(dir)).toEqual(["b.ts"]);
  });
});

describe("flagStaleForHead", () => {
  it("flags explanations whose file changed in the last commit", () => {
    const dir = newGitRepo();
    commit(dir, "a.ts", "export const a = 1;\n");

    const db = openDb(":memory:");
    const base = {
      prose: "p",
      code_snapshot: "c",
      ast_hash: "h",
    };
    saveExplanation(db, { repo: dir, file_path: "a.ts", symbol: "a", ...base });
    saveExplanation(db, { repo: dir, file_path: "b.ts", symbol: "b", ...base });

    commit(dir, "a.ts", "export const a = 99;\n");
    const result = flagStaleForHead(db, dir);

    expect(result).toEqual({ files: ["a.ts"], flagged: 1 });
    expect(
      getByLocator(db, { repo: dir, file_path: "a.ts", symbol: "a" })?.is_stale,
    ).toBe(true);
    expect(
      getByLocator(db, { repo: dir, file_path: "b.ts", symbol: "b" })?.is_stale,
    ).toBe(false);
  });

  it("flags nothing when the changed file has no stored explanation", () => {
    const dir = newGitRepo();
    commit(dir, "untracked.ts", "export const x = 1;\n");
    const db = openDb(":memory:");
    expect(flagStaleForHead(db, dir).flagged).toBe(0);
  });
});
