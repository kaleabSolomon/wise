import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export const installHookShape = {
  repo: z
    .string()
    .min(1)
    .describe("Absolute path to the git repository to install the hook into"),
};

export type InstallHookArgs = {
  [K in keyof typeof installHookShape]: z.infer<(typeof installHookShape)[K]>;
};

/** How to invoke wise from the generated hook (baked in at install time). */
export interface HookWiring {
  node: string;
  entry: string;
}

export type InstallResult =
  | { ok: true; hookPath: string; action: "installed" | "updated" }
  | {
      ok: false;
      error: "not_a_git_repo" | "foreign_hook_exists";
      message: string;
    };

// Lets us recognise a hook we wrote vs. one the user already had.
const MARKER = "# wise:post-commit";

/** Single-quote a value for safe embedding in a POSIX shell script. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderPostCommitHook(wiring: HookWiring, repo: string): string {
  return [
    "#!/bin/sh",
    MARKER,
    "# Managed by wise (install_hook). Safe to delete; re-add via install_hook.",
    `${shq(wiring.node)} ${shq(wiring.entry)} hook-flag ${shq(repo)} >/dev/null 2>&1 || true`,
    "",
  ].join("\n");
}

/**
 * Core of `install_hook`: write a post-commit hook into one repo's `.git/hooks/`.
 * Refuses to touch a non-wise hook that's already there.
 */
export function runInstallHook(
  input: InstallHookArgs,
  wiring: HookWiring,
): InstallResult {
  const repo = resolve(input.repo);
  const gitDir = join(repo, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
    return {
      ok: false,
      error: "not_a_git_repo",
      message: `${repo} is not a git repository (no .git directory).`,
    };
  }

  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-commit");

  let action: "installed" | "updated" = "installed";
  if (existsSync(hookPath)) {
    if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
      return {
        ok: false,
        error: "foreign_hook_exists",
        message: `A non-wise post-commit hook already exists at ${hookPath}; refusing to overwrite it.`,
      };
    }
    action = "updated";
  }

  writeFileSync(hookPath, renderPostCommitHook(wiring, repo), { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return { ok: true, hookPath, action };
}
