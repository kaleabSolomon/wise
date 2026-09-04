import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateInSource,
  locateInFile,
  locateAfterLine,
  enclosingSymbolNames,
} from "./locate.js";

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

describe("locateAfterLine", () => {
  // Mirrors how an anchor sits: a marker comment, then the declaration.
  const dir = mkdtempSync(join(tmpdir(), "wise-after-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function at(source: string, line: number) {
    const file = join(dir, `after-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, source);
    return locateAfterLine(file, line);
  }

  it("finds the function directly below the given line", () => {
    const r = at("// wise:7f3a9c2e\nexport function f() {}\n", 1);
    expect(r).toMatchObject({ ok: true, symbol: { name: "f" } });
  });

  it("names a class member as Class.member", () => {
    const r = at(
      [
        "class Cart {",
        "  // wise:7f3a9c2e",
        "  total() {",
        "    return 0;",
        "  }",
        "}",
      ].join("\n"),
      2,
    );
    expect(r).toMatchObject({ ok: true, symbol: { name: "Cart.total" } });
  });

  it("finds a const declaration", () => {
    const r = at("// m\nexport const rate = 0.2;\n", 1);
    expect(r).toMatchObject({ ok: true, symbol: { name: "rate" } });
  });

  it("finds a class, interface, type alias and enum", () => {
    expect(at("// m\nclass C {}\n", 1)).toMatchObject({
      ok: true,
      symbol: { name: "C" },
    });
    expect(at("// m\ninterface I { a: number }\n", 1)).toMatchObject({
      ok: true,
      symbol: { name: "I" },
    });
    expect(at("// m\ntype T = number;\n", 1)).toMatchObject({
      ok: true,
      symbol: { name: "T" },
    });
    expect(at("// m\nenum E { A }\n", 1)).toMatchObject({
      ok: true,
      symbol: { name: "E" },
    });
  });

  it("skips a declaration that sits above the line", () => {
    const source = [
      "function above() {}",
      "// wise:7f3a9c2e",
      "function below() {}",
    ].join("\n");
    expect(at(source, 2)).toMatchObject({
      ok: true,
      symbol: { name: "below" },
    });
  });

  it("reports not_found when nothing is declared below the line", () => {
    expect(at("function f() {}\n// trailing marker\n", 2)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("collapses overloads to the implementation, like a by-name lookup", () => {
    const source = [
      "// wise:7f3a9c2e",
      "export function f(a: number): number;",
      "export function f(a: string): string;",
      "export function f(a: unknown): unknown {",
      "  return a;",
      "}",
    ].join("\n");
    const r = at(source, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbol.name).toBe("f");
    expect(r.symbol.snapshot).toContain("return a;");
  });
});

describe("enclosingSymbolNames", () => {
  const dir = mkdtempSync(join(tmpdir(), "wise-enclosing-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function names(source: string, line: number) {
    const file = join(dir, `enc-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, source);
    return enclosingSymbolNames(file, line);
  }

  const NESTED = [
    "export function outer() {", // 1
    "  const local = 1;", // 2
    "  function inner() {", // 3
    "    return local;", // 4
    "  }", // 5
    "  return inner();", // 6
    "}", // 7
    "", // 8
    "export const rate = 0.2;", // 9
  ].join("\n");

  it("orders innermost first", () => {
    // Line 4 sits inside `inner`, which sits inside `outer`.
    expect(names(NESTED, 4)).toEqual(["inner", "outer"]);
  });

  it("puts a local declaration ahead of its enclosing function", () => {
    expect(names(NESTED, 2)).toEqual(["local", "outer"]);
  });

  it("returns the single declaration for a top-level const", () => {
    expect(names(NESTED, 9)).toEqual(["rate"]);
  });

  it("returns nothing for a line outside any declaration", () => {
    expect(names(NESTED, 8)).toEqual([]);
  });

  it("names a class member as Class.member, with the class after it", () => {
    const source = [
      "class Cart {",
      "  total() {",
      "    return 0;",
      "  }",
      "}",
    ].join("\n");
    expect(names(source, 3)).toEqual(["Cart.total", "Cart"]);
  });

  it("returns nothing for a file it cannot read", () => {
    expect(enclosingSymbolNames(join(dir, "does-not-exist.ts"), 1)).toEqual([]);
  });
});
