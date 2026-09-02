import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import {
  getByLocator,
  anchorsEnabled,
  setAnchorsEnabled,
} from "../store/queries.js";
import { runSave } from "./save.js";
import { runUnanchor } from "./unanchor.js";

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wise-unanchor-")));
mkdirSync(join(repo, "src"), { recursive: true });
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const BODY = `export function resolvePrice(base: number): number {
  return base * 2;
}
`;

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  writeFileSync(join(repo, "src", "pricing.ts"), BODY);
});

/** Save with anchors on, then place the marker the way an agent would. */
function saveAndPlaceAnchor(): string {
  setAnchorsEnabled(db, repo, true);
  const saved = runSave(db, {
    repo,
    file: "src/pricing.ts",
    symbol: "resolvePrice",
    prose: "Doubles the base price.",
  });
  if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
  writeFileSync(
    join(repo, "src", "pricing.ts"),
    `// ${saved.anchor.token}\n${BODY}`,
  );
  return saved.anchor.id;
}

const source = () => readFileSync(join(repo, "src", "pricing.ts"), "utf8");

describe("runUnanchor", () => {
  it("reports what it would do without touching anything", () => {
    const id = saveAndPlaceAnchor();
    const before = source();

    const report = runUnanchor(db, repo, { apply: false });

    expect(report.applied).toBe(false);
    expect(report.totalRemoved).toBe(1);
    expect(report.message).toContain("Would remove");
    expect(report.message).toContain("--apply");

    // Nothing changed: not the file, not the row, not the repo setting.
    expect(source()).toBe(before);
    expect(
      getByLocator(db, {
        repo,
        file_path: "src/pricing.ts",
        symbol: "resolvePrice",
      })?.anchor_id,
    ).toBe(id);
    expect(anchorsEnabled(db, repo)).toBe(true);
  });

  it("strips the markers and undoes the opt-in when applied", () => {
    saveAndPlaceAnchor();

    const report = runUnanchor(db, repo, { apply: true });

    expect(report.applied).toBe(true);
    expect(report.totalRemoved).toBe(1);
    expect(report.clearedRows).toBe(1);
    expect(source()).toBe(BODY);

    // A true undo: no stored id, and nothing will mint a new one.
    expect(
      getByLocator(db, {
        repo,
        file_path: "src/pricing.ts",
        symbol: "resolvePrice",
      })?.anchor_id,
    ).toBeNull();
    expect(anchorsEnabled(db, repo)).toBe(false);
  });

  it("leaves the explanation itself intact", () => {
    saveAndPlaceAnchor();
    runUnanchor(db, repo, { apply: true });

    const row = getByLocator(db, {
      repo,
      file_path: "src/pricing.ts",
      symbol: "resolvePrice",
    });
    expect(row?.prose).toBe("Doubles the base price.");
  });

  it("refuses to touch a marker sharing a line with code", () => {
    saveAndPlaceAnchor();
    const id = source().match(/wise:([0-9a-f]{8})/)?.[1];
    writeFileSync(
      join(repo, "src", "pricing.ts"),
      `export const rate = 0.2; // wise:${id}\n${BODY}`,
    );

    const report = runUnanchor(db, repo, { apply: true });

    expect(report.totalRemoved).toBe(0);
    expect(report.totalSkipped).toBe(1);
    expect(report.message).toContain("by hand");
    // The user's code is still there, untouched.
    expect(source()).toContain("export const rate = 0.2;");
  });

  it("says so plainly when there is nothing to remove", () => {
    const report = runUnanchor(db, repo, { apply: true });
    expect(report.totalRemoved).toBe(0);
    expect(report.message).toContain("No wise anchors found");
  });
});
