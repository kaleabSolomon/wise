import { statSync } from "node:fs";
import { Project, Node } from "ts-morph";
import type { SourceFile } from "ts-morph";

export interface LocatedSymbol {
  name: string;
  kind: string;
  snapshot: string;
  startLine: number;
  endLine: number;
  node: Node;
}

export type LocateResult =
  | { ok: true; symbol: LocatedSymbol }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; count: number };

export function locateInFile(
  filePath: string,
  symbolName: string,
): LocateResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  return locateSymbol(project.addSourceFileAtPath(filePath), symbolName);
}

/**
 * Locate the first declaration at or below `line` — the symbol an in-code
 * anchor is marking, whatever it is now called.
 *
 * Resolution deliberately goes through the by-name path once the name is
 * known, so an anchored lookup collapses overloads and reports ambiguity
 * exactly the way a plain one does.
 */
export function locateAfterLine(filePath: string, line: number): LocateResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  const sf = project.addSourceFileAtPath(filePath);

  const name = firstDeclarationNameAfter(sf, line);
  if (name === undefined) return { ok: false, reason: "not_found" };
  return locateSymbol(sf, name);
}

/** The declared name of `node`, in the form a locator stores it. */
function declaredName(node: Node): string | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  ) {
    return node.getName();
  }

  if (Node.isVariableStatement(node)) {
    return node.getDeclarations()[0]?.getName();
  }

  if (
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    const member = node.getName();
    const cls = node.getParent();
    const owner = Node.isClassDeclaration(cls) ? cls.getName() : undefined;
    // Members are addressed as "Class.member"; an anonymous owner leaves us
    // nothing a locator could round-trip, so decline rather than guess.
    return owner !== undefined && member !== undefined
      ? `${owner}.${member}`
      : undefined;
  }

  return undefined;
}

function firstDeclarationNameAfter(
  sf: SourceFile,
  line: number,
): string | undefined {
  let best: { line: number; name: string } | undefined;

  sf.forEachDescendant((node) => {
    const name = declaredName(node);
    if (name === undefined) return;
    // A declaration's start excludes its leading comments, so the anchor's own
    // line is never mistaken for the declaration it marks.
    const start = node.getStartLineNumber();
    if (start < line) return;
    if (best === undefined || start < best.line) best = { line: start, name };
  });

  return best?.name;
}

/*
 * Parsed-file cache for the hover path.
 *
 * A hover fires repeatedly as the pointer moves, and parsing a file per hover
 * is wasteful. Entries are keyed by mtime and size so an edited file is
 * re-parsed rather than answered from a stale tree. Deliberately small: this
 * is a latency cache, not a store.
 *
 * Only `locateEnclosing` uses it. Save and get are not hot paths, and giving
 * them a cache would mean reasoning about staleness in two places.
 */
const PARSE_CACHE_LIMIT = 8;
const parseCache = new Map<string, { key: string; sf: SourceFile }>();

function cachedSourceFile(filePath: string): SourceFile | undefined {
  let key: string;
  try {
    const stat = statSync(filePath);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }

  const hit = parseCache.get(filePath);
  if (hit?.key === key) {
    // Re-insert so eviction drops the least recently used, not the oldest.
    parseCache.delete(filePath);
    parseCache.set(filePath, hit);
    return hit.sf;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  let sf: SourceFile;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch {
    return undefined;
  }

  parseCache.set(filePath, { key, sf });
  if (parseCache.size > PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return sf;
}

/**
 * Every declaration whose span contains `line`, innermost first.
 *
 * The counterpart to `locateAfterLine`, which finds the declaration below a
 * line. Hover needs this one: a reader points at a function's name or
 * somewhere in its body, not at the marker above it.
 *
 * A list rather than a single answer, because the innermost declaration is
 * frequently not the interesting one. Pointing at `const sub = sum(items)`
 * inside `processOrder` has `sub` as its innermost declaration; the reader
 * means the function. The caller walks outward until something is actually
 * explained, which also keeps an explained local variable resolvable.
 */
export function enclosingSymbolNames(filePath: string, line: number): string[] {
  const sf = cachedSourceFile(filePath);
  if (!sf) return [];

  const found: Array<{ span: number; name: string }> = [];
  sf.forEachDescendant((node) => {
    const name = declaredName(node);
    if (name === undefined) return;
    const start = node.getStartLineNumber();
    const end = node.getEndLineNumber();
    if (line < start || line > end) return;
    found.push({ span: end - start, name });
  });

  return found
    .sort((a, b) => a.span - b.span)
    .map((entry) => entry.name)
    .filter((name, i, all) => all.indexOf(name) === i);
}

export function locateInSource(
  code: string,
  symbolName: string,
  fileName = "in-memory.ts",
): LocateResult {
  const project = new Project({ useInMemoryFileSystem: true });
  return locateSymbol(project.createSourceFile(fileName, code), symbolName);
}

function locateSymbol(sf: SourceFile, symbolName: string): LocateResult {
  const dot = symbolName.indexOf(".");
  const nodes =
    dot === -1
      ? collectTopLevel(sf, symbolName)
      : collectMember(sf, symbolName.slice(0, dot), symbolName.slice(dot + 1));

  const node = nodes[0];
  if (!node) return { ok: false, reason: "not_found" };
  if (nodes.length > 1)
    return { ok: false, reason: "ambiguous", count: nodes.length };

  return { ok: true, symbol: describe(symbolName, node) };
}

function collectTopLevel(sf: SourceFile, name: string): Node[] {
  const out: Node[] = [];

  const fns = sf.getFunctions().filter((f) => f.getName() === name);
  if (fns.length > 0) {
    // Collapse overloads to the implementation (the signature carrying a body).
    const withBody = fns.filter((f) => f.getBody() !== undefined);
    out.push(...(withBody.length > 0 ? withBody : fns.slice(-1)));
  }

  const cls = sf.getClass(name);
  if (cls) out.push(cls);

  const varDecl = sf.getVariableDeclaration(name);
  if (varDecl) out.push(varDecl.getVariableStatement() ?? varDecl);

  const iface = sf.getInterface(name);
  if (iface) out.push(iface);

  const alias = sf.getTypeAlias(name);
  if (alias) out.push(alias);

  const en = sf.getEnum(name);
  if (en) out.push(en);

  const mod = sf.getModule(name);
  if (mod) out.push(mod);

  return out;
}

function collectMember(
  sf: SourceFile,
  className: string,
  memberName: string,
): Node[] {
  const cls = sf.getClass(className);
  if (!cls) return [];

  const out: Node[] = [];
  const method = cls.getMethod(memberName);
  if (method) out.push(method);

  const prop = cls.getProperty(memberName);
  if (prop) out.push(prop);

  const getter = cls.getGetAccessor(memberName);
  if (getter) out.push(getter);

  const setter = cls.getSetAccessor(memberName);
  if (setter) out.push(setter);

  return out;
}

function describe(name: string, node: Node): LocatedSymbol {
  return {
    name,
    kind: node.getKindName(),
    snapshot: node.getText(),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    node,
  };
}
