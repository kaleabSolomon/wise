import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../store/db.js";
import { saveExplanation, type SaveInput } from "../store/queries.js";
import {
  createViewerApp,
  renderExplanationDiff,
  buildCodeDiff,
} from "./server.js";

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

describe("GET /", () => {
  it("serves the self-contained viewer page", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Wise</title>");
    expect(html).toContain("/api/explanations");
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

  it("renders the prose markdown to HTML", async () => {
    const row = saveExplanation(db, {
      ...base,
      prose: "# Title\n\nSome **bold** prose.",
    });
    const res = await app.request(`/api/explanations/${row.id}`);
    const body = (await res.json()) as { prose_html: string };
    expect(body.prose_html).toContain("<h1>Title</h1>");
    expect(body.prose_html).toContain("<strong>bold</strong>");
  });

  it("has a null explanation diff before any refresh, populated after", async () => {
    const row = saveExplanation(db, {
      ...base,
      prose: "doubles the base price",
    });
    const before = (await (
      await app.request(`/api/explanations/${row.id}`)
    ).json()) as { explanation_diff_html: string | null };
    expect(before.explanation_diff_html).toBeNull();

    saveExplanation(db, {
      ...base,
      prose: "triples the base price",
      ast_hash: "h2",
    });
    const after = (await (
      await app.request(`/api/explanations/${row.id}`)
    ).json()) as { explanation_diff_html: string | null };
    expect(after.explanation_diff_html).toContain("<del>doubles</del>");
    expect(after.explanation_diff_html).toContain("<ins>triples</ins>");
  });

  it("populates the code diff only when the snapshot changed", async () => {
    const row = saveExplanation(db, { ...base, code_snapshot: "return 2;" });

    // prose-only refresh: code unchanged → no code diff
    saveExplanation(db, {
      ...base,
      code_snapshot: "return 2;",
      prose: "reworded",
      ast_hash: "h2",
    });
    let body = (await (
      await app.request(`/api/explanations/${row.id}`)
    ).json()) as { code_diff: string | null };
    expect(body.code_diff).toBeNull();

    // code refresh → code diff present (a unified patch)
    saveExplanation(db, {
      ...base,
      code_snapshot: "return 3;",
      ast_hash: "h3",
    });
    body = (await (
      await app.request(`/api/explanations/${row.id}`)
    ).json()) as { code_diff: string | null };
    expect(body.code_diff).toContain("@@");
    expect(body.code_diff).toContain("return 3");
  });

  it("400s on a non-numeric id and 404s on a missing one", async () => {
    expect((await app.request("/api/explanations/abc")).status).toBe(400);
    expect((await app.request("/api/explanations/999")).status).toBe(404);
  });
});

describe("DELETE /api/explanations/:id", () => {
  it("deletes an explanation, then it's gone from the list", async () => {
    const row = saveExplanation(db, base);
    const del = await app.request(`/api/explanations/${row.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const list = (await (
      await app.request("/api/explanations")
    ).json()) as unknown[];
    expect(list).toHaveLength(0);
    expect((await app.request(`/api/explanations/${row.id}`)).status).toBe(404);
  });

  it("404s when deleting a missing id, 400s on a bad id", async () => {
    expect(
      (await app.request("/api/explanations/999", { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await app.request("/api/explanations/abc", { method: "DELETE" })).status,
    ).toBe(400);
  });
});

describe("static assets", () => {
  it("serves the diff2html stylesheet", async () => {
    const res = await app.request("/assets/diff2html.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("d2h");
  });

  it("serves the diff2html-ui script", async () => {
    const res = await app.request("/assets/diff2html-ui.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("Diff2HtmlUI");
  });

  it("serves the highlight.js browser bundle", async () => {
    const res = await app.request("/assets/highlight.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("hljs");
  });
});

describe("buildCodeDiff", () => {
  it("produces a unified patch of the two snapshots", () => {
    const patch = buildCodeDiff("return 2;\n", "return 3;\n", "a.ts");
    expect(patch).toContain("@@");
    expect(patch).toContain("-return 2;");
    expect(patch).toContain("+return 3;");
  });
});

describe("renderExplanationDiff", () => {
  it("marks additions and removals, keeps unchanged words plain", () => {
    const html = renderExplanationDiff("the quick fox", "the slow fox");
    expect(html).toContain("<del>quick</del>");
    expect(html).toContain("<ins>slow</ins>");
    expect(html).toContain("the ");
    expect(html).toContain(" fox");
  });

  it("escapes HTML in the prose", () => {
    const html = renderExplanationDiff("a", "a <script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
