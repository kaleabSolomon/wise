import { describe, it, expect } from "vitest";
import { firstParagraph } from "./summary.js";

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
