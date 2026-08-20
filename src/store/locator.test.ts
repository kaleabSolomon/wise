import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, normalizeLocator } from "./locator.js";

// The base is canonicalized up front: on macOS `tmpdir()` lives under the
// `/var` -> `/private/var` symlink, which is one of the very spellings this
// module exists to collapse.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-loc-")));
const repo = join(base, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");

// Whether this filesystem is case-insensitive — it decides whether asking for
// a differently-cased path can resolve at all.
mkdirSync(join(base, "CaseDir"));
const caseInsensitiveFs = existsSync(join(base, "casedir"));

afterAll(() => rmSync(base, { recursive: true, force: true }));

const norm = (file: string, repoArg: string = repo) =>
  normalizeLocator({ repo: repoArg, file, symbol: "a" });

describe("canonicalize", () => {
  it("resolves a symlinked ancestor to its real path", () => {
    const link = join(base, "link-to-repo");
    symlinkSync(repo, link);
    expect(canonicalize(join(link, "src"))).toBe(join(repo, "src"));
  });

  it("normalizes a path that does not exist yet", () => {
    const missing = join(repo, "src", "gone", "deleted.ts");
    expect(canonicalize(missing)).toBe(missing);
    expect(canonicalize(join(repo, "src", "..", "src", "nope.ts"))).toBe(
      join(repo, "src", "nope.ts"),
    );
  });

  it.skipIf(!caseInsensitiveFs)(
    "restores the real on-disk capitalization",
    () => {
      expect(canonicalize(join(base, "casedir"))).toBe(join(base, "CaseDir"));
    },
  );
});

describe("normalizeLocator", () => {
  const canonical = { repo, file_path: "src/a.ts", symbol: "a" };

  it("accepts a repo-relative path", () => {
    expect(norm("src/a.ts")).toMatchObject({ ok: true, locator: canonical });
  });

  it("accepts a dot-slash prefix", () => {
    expect(norm("./src/a.ts")).toMatchObject({ ok: true, locator: canonical });
  });

  it("accepts an absolute file path and stores it repo-relative", () => {
    expect(norm(join(repo, "src", "a.ts"))).toMatchObject({
      ok: true,
      locator: canonical,
    });
  });

  it("ignores a trailing separator on the repo", () => {
    expect(norm("src/a.ts", `${repo}/`)).toMatchObject({
      ok: true,
      locator: canonical,
    });
  });

  it("collapses interior traversal", () => {
    expect(norm("src/../src/a.ts")).toMatchObject({
      ok: true,
      locator: canonical,
    });
  });

  it("returns the absolute path alongside the locator", () => {
    const result = norm("./src/a.ts");
    expect(result.ok && result.absPath).toBe(join(repo, "src", "a.ts"));
  });

  it("keys a file that no longer exists, so its row stays reachable", () => {
    expect(norm("src/deleted.ts")).toMatchObject({
      ok: true,
      locator: { ...canonical, file_path: "src/deleted.ts" },
    });
  });

  it("trims the symbol", () => {
    expect(
      normalizeLocator({ repo, file: "src/a.ts", symbol: "  a  " }),
    ).toMatchObject({ ok: true, locator: canonical });
  });

  it("rejects a file that escapes the repo", () => {
    const result = norm("../outside/a.ts");
    expect(result).toMatchObject({ ok: false, error: "outside_repo" });
  });

  it("rejects an absolute path outside the repo", () => {
    expect(norm(join(base, "elsewhere.ts"))).toMatchObject({
      ok: false,
      error: "outside_repo",
    });
  });

  it("rejects the repo root itself", () => {
    expect(norm(".")).toMatchObject({ ok: false, error: "outside_repo" });
  });

  it.skipIf(!caseInsensitiveFs)(
    "gives differently-cased spellings of one repo the same locator",
    () => {
      const upper = norm("src/a.ts", repo.replace(/repo$/, "REPO"));
      expect(upper).toMatchObject({ ok: true, locator: canonical });
    },
  );
});

describe("normalizeLocator — symlinks inside the repo", () => {
  it("keeps the in-repo path for a file that symlinks outside", () => {
    const outsideFile = join(base, "vendored.ts");
    writeFileSync(outsideFile, "export const v = 1;\n");
    symlinkSync(outsideFile, join(repo, "vendored.ts"));

    // The target lives outside the repo, but git tracks the link at its in-repo
    // path — so that is the locator, rather than a refusal.
    expect(
      normalizeLocator({ repo, file: "vendored.ts", symbol: "v" }),
    ).toMatchObject({
      ok: true,
      locator: { repo, file_path: "vendored.ts", symbol: "v" },
    });
  });

  it("prefers the canonical path when the link stays inside the repo", () => {
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "b.ts"), "export const b = 1;\n");
    symlinkSync(join(repo, "lib"), join(repo, "linked-lib"));

    // git reports changes under lib/, so lib/ is what the locator must key by.
    expect(
      normalizeLocator({ repo, file: "linked-lib/b.ts", symbol: "b" }),
    ).toMatchObject({ ok: true, locator: { repo, file_path: "lib/b.ts" } });
  });
});
