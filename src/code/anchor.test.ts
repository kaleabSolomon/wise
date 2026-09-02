import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mintAnchorId,
  anchorToken,
  findAnchorInText,
  anchorIdAbove,
  findAnchorInRepo,
  findAllAnchorsInText,
  stripAnchorLines,
  findAnchorFiles,
} from "./anchor.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("anchor ids", () => {
  it("mints a short, unique hex id", () => {
    const id = mintAnchorId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const many = new Set(Array.from({ length: 500 }, () => mintAnchorId()));
    expect(many.size).toBe(500);
  });

  it("renders a searchable token", () => {
    expect(anchorToken("7f3a9c2e")).toBe("wise:7f3a9c2e");
  });
});

describe("findAnchorInText", () => {
  const text = ["const a = 1;", "// wise:7f3a9c2e", "function f() {}"].join(
    "\n",
  );

  it("reports the 1-based line of the marker", () => {
    expect(findAnchorInText(text, "7f3a9c2e")).toBe(2);
  });

  it("returns undefined for an id that isn't there", () => {
    expect(findAnchorInText(text, "deadbeef")).toBeUndefined();
  });

  it("finds a marker in any comment syntax, since it only matches the token", () => {
    for (const comment of [
      "# wise:aabbccdd",
      "-- wise:aabbccdd",
      "<!-- wise:aabbccdd -->",
      "/* wise:aabbccdd */",
    ]) {
      expect(findAnchorInText(`${comment}\ncode`, "aabbccdd")).toBe(1);
    }
  });
});

describe("anchorIdAbove", () => {
  it("finds the marker on the line directly above a declaration", () => {
    const text = ["// wise:7f3a9c2e", "function f() {}"].join("\n");
    expect(anchorIdAbove(text, 2)).toBe("7f3a9c2e");
  });

  it("looks back past decorators between marker and declaration", () => {
    const text = [
      "// wise:7f3a9c2e",
      "@Injectable()",
      "@Other()",
      "class Service {}",
    ].join("\n");
    expect(anchorIdAbove(text, 4)).toBe("7f3a9c2e");
  });

  it("does not reach back to an unrelated marker further up", () => {
    const text = [
      "// wise:7f3a9c2e",
      "function first() {}",
      "",
      "",
      "",
      "",
      "function second() {}",
    ].join("\n");
    expect(anchorIdAbove(text, 7)).toBeUndefined();
  });

  it("returns undefined when the declaration is at the top of the file", () => {
    expect(anchorIdAbove("function f() {}", 1)).toBeUndefined();
  });
});

describe("findAnchorInRepo", () => {
  function seedRepo(git: boolean): string {
    const dir = tempDir("wise-anchor-");
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(
      join(dir, "src", "deep", "moved.ts"),
      ["// wise:7f3a9c2e", "export function moved() {}"].join("\n"),
    );
    if (git) {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
      execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    }
    return dir;
  }

  it("finds a marker in a git repo, repo-relative", () => {
    const hit = findAnchorInRepo(seedRepo(true), "7f3a9c2e");
    expect(hit).toEqual({ file: "src/deep/moved.ts", line: 1 });
  });

  it("finds it in a plain directory too, without git", () => {
    const hit = findAnchorInRepo(seedRepo(false), "7f3a9c2e");
    expect(hit).toEqual({ file: "src/deep/moved.ts", line: 1 });
  });

  it("returns undefined when no file carries the marker", () => {
    expect(findAnchorInRepo(seedRepo(true), "deadbeef")).toBeUndefined();
  });

  it("ignores build and dependency directories in the fallback scan", () => {
    const dir = tempDir("wise-anchor-skip-");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "pkg", "index.js"),
      "// wise:ffffffff\n",
    );
    expect(findAnchorInRepo(dir, "ffffffff")).toBeUndefined();
  });
});

describe("stripAnchorLines", () => {
  it("removes a marker on its own line, in any comment syntax", () => {
    for (const comment of [
      "// wise:7f3a9c2e",
      "  # wise:7f3a9c2e",
      "<!-- wise:7f3a9c2e -->",
      "/* wise:7f3a9c2e */",
      "-- wise:7f3a9c2e",
    ]) {
      const result = stripAnchorLines(`${comment}\nfunction f() {}\n`);
      expect(result.text).toBe("function f() {}\n");
      expect(result.removed).toEqual([{ line: 1, id: "7f3a9c2e" }]);
      expect(result.skipped).toEqual([]);
    }
  });

  it("never touches a line that also holds real content", () => {
    const source = "const rate = 0.2; // wise:7f3a9c2e\n";
    const result = stripAnchorLines(source);

    expect(result.text).toBe(source);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ line: 1, id: "7f3a9c2e" }]);
  });

  it("leaves a file with no markers exactly as it was", () => {
    const source = "function f() {}\n// an ordinary comment\n";
    expect(stripAnchorLines(source).text).toBe(source);
  });

  it("removes several markers and reports each", () => {
    const source = [
      "// wise:aaaaaaaa",
      "function a() {}",
      "// wise:bbbbbbbb",
      "function b() {}",
    ].join("\n");
    const result = stripAnchorLines(source);

    expect(result.text).toBe("function a() {}\nfunction b() {}");
    expect(result.removed.map((m) => m.id)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });
});

describe("findAllAnchorsInText", () => {
  it("lists every marker with its line", () => {
    const text = ["// wise:aaaaaaaa", "code", "# wise:bbbbbbbb"].join("\n");
    expect(findAllAnchorsInText(text)).toEqual([
      { line: 1, id: "aaaaaaaa" },
      { line: 3, id: "bbbbbbbb" },
    ]);
  });

  it("returns nothing for source with no markers", () => {
    expect(findAllAnchorsInText("just code\n")).toEqual([]);
  });
});

describe("findAnchorFiles", () => {
  it("lists every file carrying a marker", () => {
    const dir = tempDir("wise-anchor-files-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "a.ts"),
      "// wise:aaaaaaaa\nexport const a = 1;\n",
    );
    writeFileSync(
      join(dir, "src", "b.ts"),
      "// wise:bbbbbbbb\nexport const b = 2;\n",
    );
    writeFileSync(join(dir, "src", "c.ts"), "export const c = 3;\n");

    expect(findAnchorFiles(dir).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns nothing for a repo with no markers", () => {
    const dir = tempDir("wise-anchor-none-");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    expect(findAnchorFiles(dir)).toEqual([]);
  });
});
