import { describe, it, expect } from "vitest";
import { locateInSource } from "./locate.js";
import { structuralHash } from "./hash.js";

function hashOf(code: string, symbol = "f"): string {
  const r = locateInSource(code, symbol);
  if (!r.ok) throw new Error(`locate failed: ${r.reason}`);
  return structuralHash(r.symbol.node);
}

const BASE = `function f(base) {
  return base * 2;
}`;

describe("structuralHash — unchanged by cosmetics", () => {
  it("ignores reformatting (whitespace / newlines)", () => {
    const reformatted = `function f(base){return base*2;}`;
    expect(hashOf(reformatted)).toBe(hashOf(BASE));
  });

  it("ignores a line comment", () => {
    const commented = `function f(base) {
  // doubles the base
  return base * 2;
}`;
    expect(hashOf(commented)).toBe(hashOf(BASE));
  });

  it("ignores a block comment", () => {
    const commented = `function f(base) {
  /* doubles the base */
  return base * 2;
}`;
    expect(hashOf(commented)).toBe(hashOf(BASE));
  });

  it("ignores a JSDoc comment", () => {
    const documented = `/** Doubles the base price. */
function f(base) {
  return base * 2;
}`;
    expect(hashOf(documented)).toBe(hashOf(BASE));
  });
});

describe("structuralHash — changed by real edits", () => {
  it("changes when an identifier is renamed", () => {
    const renamed = `function f(cost) {
  return cost * 2;
}`;
    expect(hashOf(renamed)).not.toBe(hashOf(BASE));
  });

  it("changes when a literal changes", () => {
    const edited = `function f(base) {
  return base * 3;
}`;
    expect(hashOf(edited)).not.toBe(hashOf(BASE));
  });

  it("changes when an operator changes", () => {
    const edited = `function f(base) {
  return base + 2;
}`;
    expect(hashOf(edited)).not.toBe(hashOf(BASE));
  });

  it("changes when a statement is added", () => {
    const edited = `function f(base) {
  const x = 1;
  return base * 2;
}`;
    expect(hashOf(edited)).not.toBe(hashOf(BASE));
  });
});

describe("structuralHash — shape", () => {
  it("is a deterministic 64-char hex sha256", () => {
    const h = hashOf(BASE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashOf(BASE));
  });
});
