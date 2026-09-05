import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createHoverProvider, WISE_SELECTOR } from "../src/hover.js";
import { state, reset } from "./vscode-stub.js";

/** The shape `/api/at` returns; see src/tools/at.ts in the wise repo. */
const FOUND = {
  found: true,
  id: 1,
  symbol: "processOrder",
  file: "src/orders.ts",
  prose: "Sums the order and adds 20% tax.",
  is_stale: false,
  via: "symbol" as const,
};

let calls: string[] = [];

function respond(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve({ ok, json: () => Promise.resolve(body) });
    }),
  );
}

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const doc = { uri: { scheme: "file", fsPath: "/repo/src/orders.ts" } };

/**
 * `Hover.contents` is typed as `(MarkdownString | MarkedString)[]`, and
 * MarkedString may be a bare string. Our provider always supplies a
 * MarkdownString, so narrow once here rather than casting in every assertion.
 */
function markdown(hover: { contents: unknown[] } | undefined | null): {
  value: string;
  isTrusted: boolean;
  supportHtml: boolean;
} {
  const first = hover?.contents[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("expected the hover to carry a MarkdownString");
  }
  return first as { value: string; isTrusted: boolean; supportHtml: boolean };
}

/** `line` is what a reader sees; VS Code hands providers a 0-based index. */
const hoverAtLine = (line: number) =>
  createHoverProvider().provideHover(
    doc as never,
    { line: line - 1 } as never,
    token as never,
  );

beforeEach(() => {
  reset();
  calls = [];
  respond(FOUND);
});
afterEach(() => vi.unstubAllGlobals());

describe("hover provider", () => {
  it("registers for every file-backed document, not a language list", () => {
    // Wise decides what it can resolve; enumerating languages here would drop
    // anchored files in languages nobody thought to add.
    expect(WISE_SELECTOR).toEqual({ scheme: "file" });
  });

  it("renders the symbol and the prose", async () => {
    const hover = await hoverAtLine(2);
    expect(markdown(hover).value).toContain("**processOrder**");
    expect(markdown(hover).value).toContain("Sums the order and adds 20% tax.");
  });

  it("converts the editor's 0-based line to the 1-based line wise expects", async () => {
    await hoverAtLine(2);
    expect(calls[0]).toContain("line=2");
  });

  it("sends the workspace folder as the repo and the absolute file path", async () => {
    await hoverAtLine(2);
    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("repo")).toBe("/repo");
    expect(url.searchParams.get("file")).toBe("/repo/src/orders.ts");
  });

  it("marks a stale explanation", async () => {
    respond({ ...FOUND, is_stale: true });
    expect(markdown(await hoverAtLine(2)).value).toContain("stale");
  });

  it("leaves the markdown untrusted", async () => {
    // The prose is text an agent wrote into a database. Trusted markdown could
    // run commands straight from a hover.
    const hover = await hoverAtLine(2);
    expect(markdown(hover).isTrusted).toBe(false);
    expect(markdown(hover).supportHtml).toBe(false);
  });
});

describe("hover provider — staying quiet", () => {
  it("shows nothing when the position has no explanation", async () => {
    respond({ found: false });
    expect(await hoverAtLine(2)).toBeUndefined();
  });

  it("shows nothing when disabled in settings", async () => {
    state.config["enabled"] = false;
    expect(await hoverAtLine(2)).toBeUndefined();
    expect(calls).toHaveLength(0); // and does not bother the server
  });

  it("shows nothing for a file outside any workspace folder", async () => {
    state.folder = undefined;
    expect(await hoverAtLine(2)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("shows nothing when wise is not running", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    expect(await hoverAtLine(2)).toBeUndefined();
  });

  it("shows nothing when the server answers with an error status", async () => {
    respond({ error: "bad request" }, false);
    expect(await hoverAtLine(2)).toBeUndefined();
  });

  it("honours a custom port", async () => {
    state.config["port"] = 4999;
    await hoverAtLine(2);
    expect(calls[0]).toContain("127.0.0.1:4999");
  });
});
