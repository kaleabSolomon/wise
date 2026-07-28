import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { marked } from "marked";
import { diffWords, createTwoFilesPatch } from "diff";
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

/** Unified patch of old vs current code; the viewer renders + highlights it. */
export function buildCodeDiff(
  oldCode: string,
  newCode: string,
  fileName: string,
): string {
  // Full-file context so the viewer shows the entire code, not just the hunks.
  const context = Math.max(
    oldCode.split("\n").length,
    newCode.split("\n").length,
  );
  return createTwoFilesPatch(fileName, fileName, oldCode, newCode, "", "", {
    context,
  });
}

// Read a file bundled inside an installed package, once, and cache it. Used to
// serve diff2html / highlight.js browser assets from our own origin.
const assetCache = new Map<string, string>();
function packageFile(pkg: string, relPath: string): string {
  const key = `${pkg}/${relPath}`;
  let cached = assetCache.get(key);
  if (cached === undefined) {
    const nodeRequire = createRequire(import.meta.url);
    const root = dirname(nodeRequire.resolve(`${pkg}/package.json`));
    cached = readFileSync(join(root, relPath), "utf8");
    assetCache.set(key, cached);
  }
  return cached;
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
    c.body(packageFile("diff2html", "bundles/css/diff2html.min.css"), 200, {
      "content-type": "text/css; charset=utf-8",
    }),
  );

  app.get("/assets/highlight.js", (c) =>
    c.body(packageFile("@highlightjs/cdn-assets", "highlight.min.js"), 200, {
      "content-type": "text/javascript; charset=utf-8",
    }),
  );

  // The base bundle carries no highlighter; we feed it the shared hljs above.
  app.get("/assets/diff2html-ui.js", (c) =>
    c.body(
      packageFile("diff2html", "bundles/js/diff2html-ui-base.min.js"),
      200,
      {
        "content-type": "text/javascript; charset=utf-8",
      },
    ),
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
      code_diff: codeChanged
        ? buildCodeDiff(prev.code_snapshot, row.code_snapshot, row.file_path)
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
