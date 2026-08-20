import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import { getByLocator, markStale } from "../store/queries.js";
import { runSave } from "./save.js";
import { runGet, renderGetResult, type GetExplanationArgs } from "./get.js";

const FRESH = `export function resolvePrice(base: number): number {
  return base * 2;
}
`;

// Canonical form — see the note in save.test.ts.
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-get-")));
const file = "pricing.ts";
const abs = join(repo, file);

function write(src: string) {
  writeFileSync(abs, src);
}

function save(prose: string) {
  return runSave(db, { repo, file, symbol: "resolvePrice", prose });
}

function get() {
  return runGet(db, { repo, file, symbol: "resolvePrice" });
}

afterAll(() => rmSync(repo, { recursive: true, force: true }));

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  write(FRESH);
});

describe("runGet", () => {
  it("returns not_stored when nothing is saved", () => {
    expect(get()).toEqual({ status: "not_stored", symbol: "resolvePrice" });
  });

  it("returns fresh prose when the code is unchanged", () => {
    save("Doubles the base price.");
    expect(get()).toEqual({
      status: "fresh",
      symbol: "resolvePrice",
      prose: "Doubles the base price.",
    });
  });

  it("stays fresh across reformatting and comments (structural hash)", () => {
    save("Doubles the base price.");
    write(`export function resolvePrice(base: number): number {
  // now with a comment and different spacing
  return base*2;
}
`);
    expect(get().status).toBe("fresh");
  });

  it("returns refresh materials when the code really changed", () => {
    save("Doubles the base price.");
    write(`export function resolvePrice(base: number): number {
  return base * 3;
}
`);
    const r = get();
    expect(r.status).toBe("stale");
    if (r.status !== "stale") return;
    expect(r.oldProse).toBe("Doubles the base price.");
    expect(r.oldSnapshot).toContain("base * 2");
    expect(r.currentCode).toContain("base * 3");
  });

  it("marks the row stale when it detects a change", () => {
    save("x");
    write(FRESH.replace("* 2", "* 3"));
    get();
    const stored = getByLocator(db, {
      repo,
      file_path: file,
      symbol: "resolvePrice",
    });
    expect(stored?.is_stale).toBe(true);
  });

  it("self-heals a false stale flag when the code is structurally unchanged", () => {
    save("x");
    markStale(db, { repo, file_path: file, symbol: "resolvePrice" });
    expect(get().status).toBe("fresh");
    const stored = getByLocator(db, {
      repo,
      file_path: file,
      symbol: "resolvePrice",
    });
    expect(stored?.is_stale).toBe(false);
  });

  it("falls back to stored prose when the symbol can't be re-located", () => {
    save("Doubles the base price.");
    write(`export function renamedPrice(base: number): number {
  return base * 2;
}
`);
    const r = get();
    expect(r.status).toBe("relocate_failed");
    if (r.status !== "relocate_failed") return;
    expect(r.reason).toBe("not_found");
    expect(r.prose).toBe("Doubles the base price.");
  });
});

// The bug this suite guards: a locator is both the path used to read the file
// and the key of the stored row. Every spelling below reaches the same file, so
// every one of them must reach the same row — otherwise a save appears to
// vanish and the agent re-explains from scratch.
describe("runGet — locator spellings", () => {
  const spellings = (): Array<[string, GetExplanationArgs]> => [
    ["repo-relative", { repo, file, symbol: "resolvePrice" }],
    ["dot-slash", { repo, file: `./${file}`, symbol: "resolvePrice" }],
    [
      "trailing slash on repo",
      { repo: `${repo}/`, file, symbol: "resolvePrice" },
    ],
    ["absolute file", { repo, file: abs, symbol: "resolvePrice" }],
    [
      "interior traversal",
      { repo, file: `./sub/../${file}`, symbol: "resolvePrice" },
    ],
  ];

  it("finds one saved explanation through every spelling", () => {
    save("Doubles the base price.");
    for (const [name, args] of spellings()) {
      expect(runGet(db, args), name).toMatchObject({
        status: "fresh",
        prose: "Doubles the base price.",
      });
    }
  });

  it("saving through different spellings writes one row, not several", () => {
    for (const [, args] of spellings()) {
      expect(runSave(db, { ...args, prose: "p" }).ok).toBe(true);
    }
    expect(db.prepare("SELECT COUNT(*) c FROM explanations").get()).toEqual({
      c: 1,
    });
  });

  it("refuses a file outside the repo instead of storing an unreachable row", () => {
    const outside = runSave(db, {
      repo,
      file: "../escaped.ts",
      symbol: "resolvePrice",
      prose: "p",
    });
    expect(outside).toMatchObject({ ok: false, error: "outside_repo" });
    expect(db.prepare("SELECT COUNT(*) c FROM explanations").get()).toEqual({
      c: 0,
    });

    const read = runGet(db, {
      repo,
      file: "../escaped.ts",
      symbol: "resolvePrice",
    });
    expect(read.status).toBe("outside_repo");
    expect(renderGetResult(read).isError).toBe(true);
  });
});

describe("renderGetResult", () => {
  it("returns prose verbatim when fresh", () => {
    const out = renderGetResult({
      status: "fresh",
      symbol: "f",
      prose: "hello",
    });
    expect(out).toEqual({ isError: false, text: "hello" });
  });

  it("packs old prose, old code, and current code into stale materials", () => {
    const out = renderGetResult({
      status: "stale",
      symbol: "f",
      oldProse: "OLD PROSE",
      oldSnapshot: "OLD CODE",
      currentCode: "NEW CODE",
    });
    expect(out.text).toContain("STALE");
    expect(out.text).toContain("OLD PROSE");
    expect(out.text).toContain("OLD CODE");
    expect(out.text).toContain("NEW CODE");
    expect(out.text).toContain("save_explanation");
  });
});
