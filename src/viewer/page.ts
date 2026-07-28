/**
 * The viewer UI, as a self-contained HTML string (no CDN, no build asset copy).
 * Talks to the same-origin JSON API in `server.ts`.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wise</title>
<link rel="stylesheet" href="/assets/diff2html.css" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280;
    --border: #e5e7eb; --panel: #f7f7f8; --accent: #4f46e5;
    --stale-bg: #fef3c7; --stale-fg: #92400e;
    --code-bg: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e6e6e6; --muted: #9aa0aa;
      --border: #262a33; --panel: #151821; --accent: #8b8bf5;
      --stale-bg: #3b2f14; --stale-fg: #f5d99b;
      --code-bg: #171a22;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: grid; grid-template-columns: 320px 1fr;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--fg); background: var(--bg);
  }
  aside {
    border-right: 1px solid var(--border); overflow-y: auto; background: var(--panel);
  }
  aside h1 {
    font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--muted); margin: 0; padding: 16px 16px 8px;
  }
  .item {
    padding: 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer;
  }
  .item:hover { background: var(--bg); }
  .item.active { background: var(--bg); box-shadow: inset 3px 0 0 var(--accent); }
  .item .sym { font-weight: 600; }
  .item .path { color: var(--muted); font-size: 12px; word-break: break-all; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600; border-radius: 999px;
    padding: 1px 8px; background: var(--stale-bg); color: var(--stale-fg); margin-left: 6px;
  }
  main { overflow-y: auto; padding: 28px 36px; max-width: 860px; }
  main .empty { color: var(--muted); margin-top: 40px; }
  main h2 { margin: 0 0 2px; }
  main .loc { color: var(--muted); font-size: 13px; margin-bottom: 20px; word-break: break-all; }
  .prose { border-top: 1px solid var(--border); padding-top: 20px; }
  .prose :first-child { margin-top: 0; }
  .prose pre, .prose code { background: var(--code-bg); border-radius: 6px; }
  .prose pre { padding: 12px; overflow-x: auto; }
  .prose code { padding: 1px 5px; font-size: 90%; }
  .prose pre code { padding: 0; }
  section.code { margin-top: 28px; }
  section.code summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  section.code pre {
    background: var(--code-bg); padding: 14px; border-radius: 8px; overflow-x: auto;
    margin-top: 10px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .expl-diff {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 16px; margin-bottom: 22px;
  }
  .expl-diff h3 {
    margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--muted);
  }
  .expl-diff .body { white-space: pre-wrap; }
  ins { background: rgba(46,160,67,.22); text-decoration: none; }
  del { background: rgba(248,81,73,.22); }
  .d2h { overflow-x: auto; margin-top: 10px; }
</style>
</head>
<body>
  <aside>
    <h1>Wise</h1>
    <div id="list"></div>
  </aside>
  <main id="detail"><p class="empty">Select an explanation to read it.</p></main>
<script>
  const listEl = document.getElementById("list");
  const detailEl = document.getElementById("detail");
  let activeId = null;

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  async function loadList() {
    const rows = await (await fetch("/api/explanations")).json();
    if (!rows.length) { listEl.innerHTML = '<p class="path" style="padding:12px 16px">No explanations yet.</p>'; return; }
    listEl.innerHTML = "";
    for (const r of rows) {
      const el = document.createElement("div");
      el.className = "item" + (r.id === activeId ? " active" : "");
      el.innerHTML =
        '<div class="sym">' + esc(r.symbol) + (r.is_stale ? '<span class="badge">stale</span>' : "") + "</div>" +
        '<div class="path">' + esc(r.file_path) + "</div>";
      el.onclick = () => select(r.id);
      listEl.appendChild(el);
    }
  }

  async function select(id) {
    activeId = id;
    await loadList();
    const d = await (await fetch("/api/explanations/" + id)).json();
    const diffBlock = d.explanation_diff_html
      ? '<div class="expl-diff"><h3>What changed since you last read this</h3>' +
        '<div class="body">' + d.explanation_diff_html + "</div></div>"
      : "";
    const codeSection = d.code_diff_html
      ? '<section class="code"><details><summary>What changed in the code</summary>' +
        '<div class="d2h">' + d.code_diff_html + "</div></details></section>"
      : '<section class="code"><details><summary>Current code</summary><pre>' +
        esc(d.code_snapshot) + "</pre></details></section>";
    detailEl.innerHTML =
      "<h2>" + esc(d.symbol) + (d.is_stale ? '<span class="badge">stale</span>' : "") + "</h2>" +
      '<div class="loc">' + esc(d.repo) + " › " + esc(d.file_path) + "</div>" +
      diffBlock +
      '<div class="prose">' + d.prose_html + "</div>" +
      codeSection;
  }

  loadList();
</script>
</body>
</html>
`;
