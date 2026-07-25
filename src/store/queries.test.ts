import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "./db.js";
import {
  saveExplanation,
  getByLocator,
  markStale,
  clearStale,
  latestVersion,
  type SaveInput,
} from "./queries.js";

const base: SaveInput = {
  repo: "r",
  file_path: "src/a.ts",
  symbol: "resolvePrice",
  prose: "gen1 prose",
  code_snapshot: "function resolvePrice() { return 1; }",
  ast_hash: "h1",
};

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("saveExplanation / getByLocator", () => {
  it("round-trips a saved explanation", () => {
    saveExplanation(db, base);
    const got = getByLocator(db, base);
    expect(got).toMatchObject({
      repo: "r",
      file_path: "src/a.ts",
      symbol: "resolvePrice",
      prose: "gen1 prose",
      ast_hash: "h1",
      is_stale: 0,
    });
    expect(got?.id).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown locator", () => {
    expect(getByLocator(db, base)).toBeUndefined();
  });

  it("overwrites in place rather than inserting a duplicate", () => {
    const first = saveExplanation(db, base);
    const second = saveExplanation(db, { ...base, prose: "gen2 prose", ast_hash: "h2" });
    expect(second.id).toBe(first.id);
    expect(second.prose).toBe("gen2 prose");
    expect(db.prepare("SELECT COUNT(*) c FROM explanations").get()).toEqual({ c: 1 });
  });
});

describe("history", () => {
  it("pushes the outgoing generation into versions on overwrite", () => {
    const row = saveExplanation(db, base);
    expect(latestVersion(db, row.id)).toBeUndefined();

    saveExplanation(db, { ...base, prose: "gen2 prose", ast_hash: "h2" });
    saveExplanation(db, { ...base, prose: "gen3 prose", ast_hash: "h3" });

    const prev = latestVersion(db, row.id);
    expect(prev?.prose).toBe("gen2 prose");
    expect(db.prepare("SELECT COUNT(*) c FROM explanation_versions").get()).toEqual({ c: 2 });
  });
});

describe("stale lifecycle", () => {
  it("marks and clears the stale flag", () => {
    saveExplanation(db, base);
    expect(markStale(db, base)).toBe(true);
    expect(getByLocator(db, base)?.is_stale).toBe(1);
    expect(clearStale(db, base)).toBe(true);
    expect(getByLocator(db, base)?.is_stale).toBe(0);
  });

  it("clears stale when a stale row is re-saved", () => {
    saveExplanation(db, base);
    markStale(db, base);
    saveExplanation(db, { ...base, prose: "refreshed", ast_hash: "h2" });
    expect(getByLocator(db, base)?.is_stale).toBe(0);
  });

  it("reports no change for an unknown locator", () => {
    expect(markStale(db, base)).toBe(false);
  });
});
