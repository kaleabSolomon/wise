import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateInSource, locateInFile } from "./locate.js";

const SRC = `import { x } from "y";

export function resolvePrice(base: number): number {
  return base * 2;
}

export const applyDiscount = (n: number): number => n - 1;

export class Cart {
  total(): number {
    return 0;
  }
}

interface Order {
  id: number;
}

type Money = number;

enum Kind {
  A,
  B,
}
`;

function found(code: string, symbol: string) {
  const r = locateInSource(code, symbol);
  if (!r.ok) throw new Error(`expected to locate ${symbol}, got ${r.reason}`);
  return r.symbol;
}

describe("locateInSource", () => {
  it("locates a function declaration with its span", () => {
    const s = found(SRC, "resolvePrice");
    expect(s.kind).toBe("FunctionDeclaration");
    expect(s.snapshot).toContain("function resolvePrice");
    expect(s.snapshot).toContain("return base * 2;");
    expect(s.startLine).toBe(3);
    expect(s.endLine).toBe(5);
  });

  it("locates a const arrow function and includes the declaration keyword", () => {
    const s = found(SRC, "applyDiscount");
    expect(s.kind).toBe("VariableStatement");
    expect(s.snapshot).toContain("export const applyDiscount");
  });

  it("locates a class", () => {
    expect(found(SRC, "Cart").kind).toBe("ClassDeclaration");
  });

  it("locates a class method via qualified name", () => {
    const s = found(SRC, "Cart.total");
    expect(s.kind).toBe("MethodDeclaration");
    expect(s.snapshot).toContain("total(): number");
  });

  it("locates interfaces, type aliases, and enums", () => {
    expect(found(SRC, "Order").kind).toBe("InterfaceDeclaration");
    expect(found(SRC, "Money").kind).toBe("TypeAliasDeclaration");
    expect(found(SRC, "Kind").kind).toBe("EnumDeclaration");
  });

  it("collapses function overloads to the implementation", () => {
    const overloaded = `function f(a: number): number;
function f(a: string): string;
function f(a: unknown): unknown {
  return a;
}`;
    const s = found(overloaded, "f");
    expect(s.snapshot).toContain("return a;");
  });

  it("reports not_found for an unknown symbol", () => {
    const r = locateInSource(SRC, "nope");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports not_found for a member of an unknown class", () => {
    const r = locateInSource(SRC, "Ghost.method");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports ambiguous when a name resolves to more than one declaration", () => {
    // Invalid TS (redeclaration), but the locator must refuse rather than guess.
    const dup = `function dup() {}
const dup = 1;`;
    const r = locateInSource(dup, "dup");
    expect(r).toEqual({ ok: false, reason: "ambiguous", count: 2 });
  });
});

describe("locateInFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "wise-locate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("locates a symbol read from a real file", () => {
    const file = join(dir, "sample.ts");
    writeFileSync(file, SRC);
    const r = locateInFile(file, "resolvePrice");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.symbol.kind).toBe("FunctionDeclaration");
  });
});
