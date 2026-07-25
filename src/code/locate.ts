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
