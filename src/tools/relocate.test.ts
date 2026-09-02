import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../store/db.js";
import {
  getByLocator,
  setAnchorsEnabled,
  listExplanations,
} from "../store/queries.js";
import { runSave } from "./save.js";
import { runGet } from "./get.js";

const repo = realpathSync.native(
  mkdtempSync(join(tmpdir(), "wise-anchor-e2e-")),
);
mkdirSync(join(repo, "src"), { recursive: true });
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const ORIGINAL = `export function resolvePrice(base: number): number {
  return base * 2;
}
`;

/** The file as it looks once the agent has placed the anchor wise asked for. */
function writeWithAnchor(path: string, token: string, body: string): void {
  writeFileSync(join(repo, path), `// ${token}\n${body}`);
}

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  writeFileSync(join(repo, "src", "pricing.ts"), ORIGINAL);
  rmSync(join(repo, "src", "billing.ts"), { force: true });
});

function saveOriginal(prose = "Doubles the base price.") {
  return runSave(db, {
    repo,
    file: "src/pricing.ts",
    symbol: "resolvePrice",
    prose,
  });
}

describe("anchors — minting", () => {
  it("mints nothing when the repo has not opted in", () => {
    const result = saveOriginal();
    expect(result.ok && result.anchor).toBeUndefined();
    expect(result.ok && result.message).not.toContain("wise:");
  });

  it("mints a marker and says where to put it once opted in", () => {
    setAnchorsEnabled(db, repo, true);
    const result = saveOriginal();

    expect(result.ok).toBe(true);
    if (!result.ok || !result.anchor) throw new Error("expected an anchor");
    expect(result.anchor.token).toBe(`wise:${result.anchor.id}`);
    expect(result.message).toContain(result.anchor.token);
    expect(result.message).toContain("src/pricing.ts");
    expect(result.message).toContain("resolvePrice");
  });

  it("does not mint a second time, nor nag when the comment is deleted", () => {
    setAnchorsEnabled(db, repo, true);
    const first = saveOriginal();
    if (!first.ok || !first.anchor) throw new Error("expected an anchor");

    // The user never places it (or places it, then deletes it later).
    const again = saveOriginal("Refreshed.");
    expect(again.ok && again.anchor).toBeUndefined();
    expect(again.ok && again.message).not.toContain("wise:");

    const stored = getByLocator(db, {
      repo,
      file_path: "src/pricing.ts",
      symbol: "resolvePrice",
    });
    expect(stored?.anchor_id).toBe(first.anchor.id);
  });
});

/*
 * An anchor keeps an explanation *attached* to its code. It does not make a
 * rename look like a non-event: the structural hash counts a renamed
 * identifier as a change (see hash.ts), and it should — prose that talks about
 * `resolvePrice` is subtly wrong once the symbol is called something else.
 *
 * The win is the shape of the answer. Before anchors a rename produced
 * `relocate_failed` — stale prose and a shrug. Now it produces a normal
 * refresh, with the old explanation, the old code and the new code.
 */
describe("anchors — surviving a rename", () => {
  it("follows the symbol to its new name and heals the locator", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor("src/pricing.ts", saved.anchor.token, ORIGINAL);

    // Renamed, body untouched.
    writeWithAnchor(
      "src/pricing.ts",
      saved.anchor.token,
      ORIGINAL.replace("resolvePrice", "computePrice"),
    );

    const result = runGet(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "computePrice",
    });

    // Found and refreshable — not orphaned, which is what used to happen.
    expect(result.status).toBe("stale");
    if (result.status !== "stale") return;
    expect(result.symbol).toBe("computePrice");
    expect(result.oldProse).toBe("Doubles the base price.");
    expect(result.oldSnapshot).toContain("resolvePrice");
    expect(result.currentCode).toContain("computePrice");

    // The row now points at the new name, and there is still only one of them.
    expect(listExplanations(db)).toHaveLength(1);
    expect(
      getByLocator(db, {
        repo,
        file_path: "src/pricing.ts",
        symbol: "computePrice",
      }),
    ).toBeDefined();
  });

  it("still answers when asked by the OLD name after a rename", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor(
      "src/pricing.ts",
      saved.anchor.token,
      ORIGINAL.replace("resolvePrice", "computePrice"),
    );

    // Reached through the stored locator rather than the anchor, but the
    // anchor is what lets the code be found once the name no longer matches.
    const result = runGet(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "resolvePrice",
    });
    expect(result.status).toBe("stale");
    expect(result.status === "stale" && result.symbol).toBe("computePrice");
  });

  it("refreshing after a rename updates in place instead of adding a row", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor(
      "src/pricing.ts",
      saved.anchor.token,
      ORIGINAL.replace("resolvePrice", "computePrice"),
    );

    const again = runSave(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "computePrice",
      prose: "Doubles the base price. (renamed)",
    });
    expect(again.ok).toBe(true);
    expect(listExplanations(db)).toHaveLength(1);
  });
});

describe("anchors — surviving a move", () => {
  it("follows the file to its new path and heals the locator", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor("src/pricing.ts", saved.anchor.token, ORIGINAL);

    renameSync(
      join(repo, "src", "pricing.ts"),
      join(repo, "src", "billing.ts"),
    );

    // Asked at its old address — the anchor is what finds it.
    const result = runGet(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "resolvePrice",
    });
    expect(result.status).toBe("fresh");

    expect(
      getByLocator(db, {
        repo,
        file_path: "src/billing.ts",
        symbol: "resolvePrice",
      }),
    ).toBeDefined();
  });

  it("survives a rename and a move at the same time", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor(
      "src/pricing.ts",
      saved.anchor.token,
      ORIGINAL.replace("resolvePrice", "computePrice"),
    );
    renameSync(
      join(repo, "src", "pricing.ts"),
      join(repo, "src", "billing.ts"),
    );

    expect(
      runGet(db, { repo, file: "src/pricing.ts", symbol: "resolvePrice" })
        .status,
    ).toBe("stale");
    expect(
      getByLocator(db, {
        repo,
        file_path: "src/billing.ts",
        symbol: "computePrice",
      }),
    ).toBeDefined();
  });

  it("reports a real change as stale, not as a relocation", () => {
    setAnchorsEnabled(db, repo, true);
    const saved = saveOriginal();
    if (!saved.ok || !saved.anchor) throw new Error("expected an anchor");
    writeWithAnchor(
      "src/pricing.ts",
      saved.anchor.token,
      ORIGINAL.replace("base * 2", "base * 3").replace(
        "resolvePrice",
        "computePrice",
      ),
    );

    const result = runGet(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "computePrice",
    });
    expect(result.status).toBe("stale");
  });
});

describe("anchors — the unanchored path is unchanged", () => {
  it("a rename without an anchor fails exactly as it did before", () => {
    saveOriginal(); // anchors off, so nothing is minted
    writeFileSync(
      join(repo, "src", "pricing.ts"),
      ORIGINAL.replace("resolvePrice", "computePrice"),
    );

    const result = runGet(db, {
      repo,
      file: "src/pricing.ts",
      symbol: "resolvePrice",
    });
    expect(result).toMatchObject({
      status: "relocate_failed",
      reason: "not_found",
    });
  });

  it("asking about an unrelated symbol is still not_stored", () => {
    saveOriginal();
    expect(
      runGet(db, { repo, file: "src/pricing.ts", symbol: "somethingElse" })
        .status,
    ).toBe("not_stored");
  });
});
