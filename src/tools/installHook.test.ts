import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../store/db.js";
import { saveExplanation, getByLocator } from "../store/queries.js";
import {
  runInstallHook,
  renderPostCommitHook,
  type HookWiring,
} from "./installHook.js";

const wiring: HookWiring = {
  node: "/usr/bin/node",
  entry: "/opt/wise/index.js",
};
const dirs: string[] = [];

function newGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wise-install-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("renderPostCommitHook", () => {
  it("bakes in the invocation and safely quotes paths with spaces", () => {
    const script = renderPostCommitHook(
      { node: "/n o de", entry: "/e n try" },
      "/my repo",
    );
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain("hook-flag");
    expect(script).toContain("'/n o de'");
    expect(script).toContain("'/my repo'");
    expect(script).toContain("|| true");
  });
});

describe("runInstallHook", () => {
  it("writes an executable hook into .git/hooks", () => {
    const dir = newGitRepo();
    const r = runInstallHook({ repo: dir }, wiring);
    expect(r).toMatchObject({ ok: true, action: "installed" });
    if (!r.ok) return;

    const contents = readFileSync(r.hookPath, "utf8");
    expect(contents).toContain("# wise:post-commit");
    expect(contents).toContain(dir);
    expect(statSync(r.hookPath).mode & 0o111).not.toBe(0);
  });

  it("updates its own hook idempotently", () => {
    const dir = newGitRepo();
    runInstallHook({ repo: dir }, wiring);
    const again = runInstallHook({ repo: dir }, wiring);
    expect(again).toMatchObject({ ok: true, action: "updated" });
  });

  it("refuses to overwrite a foreign post-commit hook", () => {
    const dir = newGitRepo();
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho not ours\n");
    const r = runInstallHook({ repo: dir }, wiring);
    expect(r).toMatchObject({ ok: false, error: "foreign_hook_exists" });
    expect(readFileSync(hookPath, "utf8")).toContain("echo not ours");
  });

  it("reports when the target is not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "wise-nongit-"));
    dirs.push(dir);
    const r = runInstallHook({ repo: dir }, wiring);
    expect(r).toMatchObject({ ok: false, error: "not_a_git_repo" });
  });
});

describe("end to end", () => {
  it("installed hook flags the store when a commit lands", () => {
    const dir = newGitRepo();
    const dbPath = join(dir, "store.db");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["-C", dir, "add", "a.ts"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    const db = openDb(dbPath);
    saveExplanation(db, {
      repo: dir,
      file_path: "a.ts",
      symbol: "a",
      prose: "p",
      code_snapshot: "c",
      ast_hash: "h",
    });

    // Wire the hook to run this source via tsx (dev), sharing the temp store.
    const tsxBin = fileURLToPath(
      new URL("../../node_modules/.bin/tsx", import.meta.url),
    );
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    expect(runInstallHook({ repo: dir }, { node: tsxBin, entry }).ok).toBe(
      true,
    );

    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    execFileSync("git", ["-C", dir, "add", "a.ts"]);
    process.env["WISE_DB_PATH"] = dbPath;
    try {
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", "change"]);
    } finally {
      delete process.env["WISE_DB_PATH"];
    }

    const stored = getByLocator(openDb(dbPath), {
      repo: dir,
      file_path: "a.ts",
      symbol: "a",
    });
    expect(stored?.is_stale).toBe(true);
  }, 30_000);
});
