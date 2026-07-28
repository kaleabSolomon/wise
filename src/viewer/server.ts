import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { marked } from "marked";
import { diffWords, createTwoFilesPatch } from "diff";
import { html as diff2html } from "diff2html";
import type { DB } from "../store/db.js";
import { listExplanations, getById, latestVersion } from "../store/queries.js";
import { PAGE_HTML } from "./page.js";

/** Render display-only markdown to HTML. Synchronous; never touches a repo. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false });
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );

/**
 * Inline word-level diff of old vs new prose — the headline "how your mental
 * model should update". Additions become <ins>, removals <del>.
 */
export function renderExplanationDiff(
  oldProse: string,
  newProse: string,
): string {
  return diffWords(oldProse, newProse)
    .map((part) => {
      const text = escapeHtml(part.value);
      if (part.added) return `<ins>${text}</ins>`;
      if (part.removed) return `<del>${text}</del>`;
      return text;
    })
    .join("");
}

/** GitHub-style side-by-side diff of old vs current code (secondary view). */
export function renderCodeDiff(
  oldCode: string,
  newCode: string,
  fileName: string,
): string {
  const patch = createTwoFilesPatch(fileName, fileName, oldCode, newCode);
  return diff2html(patch, {
    drawFileList: false,
    matching: "lines",
    outputFormat: "side-by-side",
  });
}

// diff2html's stylesheet, read from the installed package once and cached.
let diff2htmlCssCache: string | null = null;
function diff2htmlCss(): string {
  if (diff2htmlCssCache === null) {
    const nodeRequire = createRequire(import.meta.url);
    const pkgRoot = dirname(nodeRequire.resolve("diff2html/package.json"));
    diff2htmlCssCache = readFileSync(
      join(pkgRoot, "bundles/css/diff2html.min.css"),
      "utf8",
    );
  }
  return diff2htmlCssCache;
}

/**
 * The viewer's read-only HTTP API over the store, plus the page itself. Detail
 * includes the previous generation so the client can render both diffs
 * (explanation + code). Building the app from an injected `db` keeps it testable
 * without a running server.
 */
export function createViewerApp(db: DB): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(PAGE_HTML));

  app.get("/assets/diff2html.css", (c) =>
    c.body(diff2htmlCss(), 200, { "content-type": "text/css; charset=utf-8" }),
  );

  app.get("/api/explanations", (c) => c.json(listExplanations(db)));

  app.get("/api/explanations/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const row = getById(db, id);
    if (!row) return c.json({ error: "not found" }, 404);

    const prev = latestVersion(db, id);
    const codeChanged = prev && prev.code_snapshot !== row.code_snapshot;
    return c.json({
      ...row,
      prose_html: renderMarkdown(row.prose),
      explanation_diff_html: prev
        ? renderExplanationDiff(prev.prose, row.prose)
        : null,
      code_diff_html: codeChanged
        ? renderCodeDiff(prev.code_snapshot, row.code_snapshot, row.file_path)
        : null,
      previous: prev
        ? {
            prose: prev.prose,
            code_snapshot: prev.code_snapshot,
            created_at: prev.created_at,
          }
        : null,
    });
  });

  return app;
}
