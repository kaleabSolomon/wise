import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import { saveExplanation, setAnchor } from "../store/queries.js";
import { explanationAt, firstParagraph } from "./at.js";

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-at-")));
mkdirSync(join(repo, "src"), { recursive: true });
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const TS_SRC = `import { sum } from "./util";

export function processOrder(order: Order): Receipt {
  const sub = sum(order.items);
  return { sub, total: sub * 1.2 };
}

export function unrelated(): void {
  console.log("nothing to do with the above");
}
`;

// Python: wise cannot parse it, so only an anchor can resolve anything here.
const PY_SRC = `import math

# wise:aaaaaaaa
def process_order(order):
    return sum(i.price for i in order.items)


def unanchored_helper(value):
    return value * 2
`;

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  writeFileSync(join(repo, "src", "orders.ts"), TS_SRC);
  writeFileSync(join(repo, "src", "orders.py"), PY_SRC);
});

function store(file: string, symbol: string, prose: string) {
  return saveExplanation(db, {
    repo,
    file_path: file,
    symbol,
    prose,
    code_snapshot: "c",
    ast_hash: "h",
  });
}

const at = (file: string, line: number) =>
  explanationAt(db, { repo, file, line });

describe("explanationAt — TypeScript, by symbol", () => {
  beforeEach(() => store("src/orders.ts", "processOrder", "Totals an order."));

  it("resolves from the declaration line", () => {
    expect(at("src/orders.ts", 3)).toMatchObject({
      found: true,
      symbol: "processOrder",
      prose: "Totals an order.",
      via: "symbol",
    });
  });

  it("resolves from anywhere inside the body", () => {
    // ts-morph knows the declaration's extent, so pointing at a line in the
    // middle of the function is as good as pointing at its name.
    expect(at("src/orders.ts", 4)).toMatchObject({
      found: true,
      via: "symbol",
    });
    expect(at("src/orders.ts", 5)).toMatchObject({
      found: true,
      via: "symbol",
    });
  });

  it("finds nothing inside a different, unexplained function", () => {
    expect(at("src/orders.ts", 9)).toEqual({ found: false });
  });

  it("finds nothing on a blank line between declarations", () => {
    expect(at("src/orders.ts", 7)).toEqual({ found: false });
  });

  it("finds nothing when the file has no stored explanation at all", () => {
    const fresh = openDb(":memory:");
    expect(
      explanationAt(fresh, { repo, file: "src/orders.ts", line: 3 }),
    ).toEqual({
      found: false,
    });
  });
});

describe("explanationAt — any language, by anchor", () => {
  beforeEach(() => {
    const row = store("src/orders.py", "process_order", "Totals an order.");
    setAnchor(db, row.id, "aaaaaaaa");
  });

  it("resolves on the declaration line below the marker", () => {
    expect(at("src/orders.py", 4)).toMatchObject({
      found: true,
      symbol: "process_order",
      via: "anchor",
    });
  });

  it("resolves on the marker's own line", () => {
    expect(at("src/orders.py", 3)).toMatchObject({
      found: true,
      via: "anchor",
    });
  });

  /*
   * The case that set the rule. Walking up to "the nearest anchor above the
   * cursor" would answer here with process_order's explanation while the
   * reader is pointing at a different, unexplained function. Answering
   * confidently and wrongly is worse than answering nothing.
   */
  it("does not claim an unanchored function further down the file", () => {
    expect(at("src/orders.py", 8)).toEqual({ found: false });
    expect(at("src/orders.py", 9)).toEqual({ found: false });
  });

  it("finds nothing inside the anchored body, since the extent is unknown", () => {
    expect(at("src/orders.py", 5)).toEqual({ found: false });
  });

  it("ignores an anchor belonging to a different repo", () => {
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-at2-")));
    try {
      expect(
        explanationAt(db, { repo: other, file: "src/orders.py", line: 4 }),
      ).toEqual({ found: false });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("explanationAt — falling back to the anchor after a rename", () => {
  it("still resolves a TS symbol whose name changed under it", () => {
    const row = store("src/orders.ts", "processOrder", "Totals an order.");
    setAnchor(db, row.id, "bbbbbbbb");
    writeFileSync(
      join(repo, "src", "orders.ts"),
      TS_SRC.replace(
        "export function processOrder",
        "// wise:bbbbbbbb\nexport function buildReceipt",
      ),
    );

    // Line 4 is now the renamed declaration; the by-name lookup misses and the
    // anchor on the line above carries it.
    expect(at("src/orders.ts", 4)).toMatchObject({
      found: true,
      symbol: "processOrder",
      via: "anchor",
    });
  });
});

describe("explanationAt — bad input", () => {
  it("finds nothing for a path outside the repo", () => {
    expect(at("../escaped.ts", 1)).toEqual({ found: false });
  });

  it("finds nothing for a file that does not exist", () => {
    expect(at("src/missing.ts", 1)).toEqual({ found: false });
  });
});

describe("firstParagraph", () => {
  it("takes the opening paragraph", () => {
    expect(firstParagraph("First one.\n\nSecond one.")).toBe("First one.");
  });

  it("skips a leading heading, which says nothing on its own", () => {
    // Both of the long explanations in the author's own store open this way.
    const prose =
      "## BitReader\n\nA cursor over a Uint8Array.\n\n### State\n\nMore.";
    expect(firstParagraph(prose)).toBe("A cursor over a Uint8Array.");
  });

  it("skips several stacked headings", () => {
    expect(firstParagraph("# A\n\n## B\n\nBody text.")).toBe("Body text.");
  });

  it("keeps a list as a list rather than flattening it", () => {
    const prose = "- one\n- two\n\nAfter.";
    expect(firstParagraph(prose)).toBe("- one\n- two");
  });

  it("keeps line breaks inside the block", () => {
    expect(firstParagraph("line one\nline two\n\nnext")).toBe(
      "line one\nline two",
    );
  });

  it("truncates at a word boundary past the limit", () => {
    const prose =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const out = firstParagraph(prose, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain("brav…"); // cut between words, not mid-word
  });

  it("still truncates when there is no usable word boundary", () => {
    const out = firstParagraph("a".repeat(50), 10);
    expect(out).toBe(`${"a".repeat(10)}…`);
  });

  it("falls back to the heading when there is nothing else", () => {
    expect(firstParagraph("## Only a heading")).toBe("## Only a heading");
  });

  it("handles empty prose", () => {
    expect(firstParagraph("")).toBe("");
  });
});
