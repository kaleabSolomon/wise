import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../store/db.js";
import { saveExplanation, type SaveInput } from "../store/queries.js";
import { createViewerApp } from "./server.js";

const base: SaveInput = {
  repo: "/r",
  file_path: "a.ts",
  symbol: "resolvePrice",
  prose: "gen1 prose",
  code_snapshot: "gen1 code",
  ast_hash: "h1",
};

let db: DB;
let app: ReturnType<typeof createViewerApp>;
beforeEach(() => {
  db = openDb(":memory:");
  app = createViewerApp(db);
});

describe("GET /api/explanations", () => {
  it("lists stored explanations, newest first", async () => {
    saveExplanation(db, base);
    saveExplanation(db, { ...base, file_path: "b.ts", symbol: "other" });

    const res = await app.request("/api/explanations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      symbol: string;
      is_stale: boolean;
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.symbol).toBe("other");
    expect(body[0]?.is_stale).toBe(false);
  });

  it("returns an empty array when the store is empty", async () => {
    const res = await app.request("/api/explanations");
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/explanations/:id", () => {
  it("returns detail with previous = null before any refresh", async () => {
    const row = saveExplanation(db, base);
    const res = await app.request(`/api/explanations/${row.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      symbol: string;
      prose: string;
      previous: unknown;
    };
    expect(body.symbol).toBe("resolvePrice");
    expect(body.prose).toBe("gen1 prose");
    expect(body.previous).toBeNull();
  });

  it("includes the prior generation for diffing after a re-save", async () => {
    const row = saveExplanation(db, base);
    saveExplanation(db, {
      ...base,
      prose: "gen2 prose",
      code_snapshot: "gen2 code",
      ast_hash: "h2",
    });

    const res = await app.request(`/api/explanations/${row.id}`);
    const body = (await res.json()) as {
      prose: string;
      code_snapshot: string;
      previous: { prose: string; code_snapshot: string } | null;
    };
    expect(body.prose).toBe("gen2 prose");
    expect(body.previous?.prose).toBe("gen1 prose");
    expect(body.previous?.code_snapshot).toBe("gen1 code");
  });

  it("400s on a non-numeric id and 404s on a missing one", async () => {
    expect((await app.request("/api/explanations/abc")).status).toBe(400);
    expect((await app.request("/api/explanations/999")).status).toBe(404);
  });
});
