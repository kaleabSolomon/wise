/**
 * The viewer UI, as a self-contained HTML string (assets served same-origin).
 * Navigation is two-level: projects (repos) → that project's explanations →
 * detail. The code diff is rendered and syntax-highlighted client-side by
 * diff2html-ui (bundles highlight.js).
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
  .nav-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--muted); padding: 16px 16px 8px;
  }
  .back {
    cursor: pointer; color: var(--accent); text-transform: none; letter-spacing: 0;
    font-size: 13px;
  }
  .item {
    padding: 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer;
    display: flex; align-items: center; gap: 8px;
  }
  .item:hover { background: var(--bg); }
  .item.active { background: var(--bg); box-shadow: inset 3px 0 0 var(--accent); }
  .item .main { min-width: 0; flex: 1; }
  .item .sym { font-weight: 600; }
  .item .path { color: var(--muted); font-size: 12px; word-break: break-all; }
  .item .count { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600; border-radius: 999px;
    padding: 1px 8px; background: var(--stale-bg); color: var(--stale-fg);
  }
  main { overflow-y: auto; padding: 28px 40px; }
  main .empty { color: var(--muted); margin-top: 40px; }
  main h2 { margin: 0 0 2px; }
  main .loc { color: var(--muted); font-size: 13px; margin-bottom: 20px; word-break: break-all; }
  /* Prose reads best at a limited measure; code/diff get the full width. */
  .prose { border-top: 1px solid var(--border); padding-top: 20px; max-width: 760px; }
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
    padding: 14px 16px; margin-bottom: 22px; max-width: 760px;
  }
  .expl-diff h3 {
    margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--muted);
  }
  .expl-diff .body { white-space: pre-wrap; }
  ins { background: rgba(46,160,67,.22); text-decoration: none; }
  del { background: rgba(248,81,73,.22); }
  .d2h { overflow-x: auto; margin-top: 10px; }

  /* highlight.js tokens — compact GitHub-ish theme */
  .hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-name, .hljs-tag { color: #d73a49; }
  .hljs-string, .hljs-doctag, .hljs-regexp, .hljs-addition { color: #032f62; }
  .hljs-title, .hljs-title.function_, .hljs-section, .hljs-built_in { color: #6f42c1; }
  .hljs-number, .hljs-symbol, .hljs-attr, .hljs-attribute, .hljs-meta { color: #005cc5; }
  @media (prefers-color-scheme: dark) {
    .hljs-comment, .hljs-quote { color: #8b949e; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-name, .hljs-tag { color: #ff7b72; }
    .hljs-string, .hljs-doctag, .hljs-regexp, .hljs-addition { color: #a5d6ff; }
    .hljs-title, .hljs-title.function_, .hljs-section, .hljs-built_in { color: #d2a8ff; }
    .hljs-number, .hljs-symbol, .hljs-attr, .hljs-attribute, .hljs-meta { color: #79c0ff; }
  }
</style>
</head>
<body>
  <aside><div id="nav"></div></aside>
  <main id="detail"><p class="empty">Select an explanation to read it.</p></main>
<script src="/assets/highlight.js"></script>
<script src="/assets/diff2html-ui.js"></script>
<script>
  const navEl = document.getElementById("nav");
  const detailEl = document.getElementById("detail");
  let activeId = null;

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const projectName = (repo) => repo.replace(/\\/+$/, "").split("/").pop() || repo;

  const LANGS = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", py: "python", go: "go", rs: "rust", java: "java", rb: "ruby",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp", php: "php", sh: "bash",
    css: "css", html: "xml", xml: "xml", yml: "yaml", yaml: "yaml", sql: "sql",
    kt: "kotlin", swift: "swift",
  };
  const langOf = (file) => LANGS[(file.split(".").pop() || "").toLowerCase()] || "";

  async function fetchRows() {
    return await (await fetch("/api/explanations")).json();
  }

  async function showProjects() {
    const rows = await fetchRows();
    if (!rows.length) {
      navEl.innerHTML = '<div class="nav-head">Wise</div><p class="path" style="padding:0 16px">No explanations yet.</p>';
      return;
    }
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.repo)) groups.set(r.repo, []);
      groups.get(r.repo).push(r);
    }
    navEl.innerHTML = '<div class="nav-head">Projects</div>';
    for (const [repo, items] of groups) {
      const stale = items.filter((i) => i.is_stale).length;
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML =
        '<div class="main"><div class="sym">' + esc(projectName(repo)) + "</div>" +
        '<div class="path">' + esc(repo) + "</div></div>" +
        '<div class="count">' + items.length + (stale ? ' · <span class="badge">' + stale + " stale</span>" : "") + "</div>";
      el.onclick = () => showExplanations(repo);
      navEl.appendChild(el);
    }
  }

  async function showExplanations(repo) {
    const rows = (await fetchRows()).filter((r) => r.repo === repo);
    navEl.innerHTML =
      '<div class="nav-head"><span class="back">‹ Projects</span></div>' +
      '<div class="nav-head" style="padding-top:0">' + esc(projectName(repo)) + "</div>";
    navEl.querySelector(".back").onclick = showProjects;
    for (const r of rows) {
      const el = document.createElement("div");
      el.className = "item" + (r.id === activeId ? " active" : "");
      el.innerHTML =
        '<div class="main"><div class="sym">' + esc(r.symbol) +
        (r.is_stale ? ' <span class="badge">stale</span>' : "") + "</div>" +
        '<div class="path">' + esc(r.file_path) + "</div></div>";
      el.onclick = () => {
        activeId = r.id;
        for (const s of navEl.querySelectorAll(".item")) s.classList.remove("active");
        el.classList.add("active");
        loadDetail(r.id);
      };
      navEl.appendChild(el);
    }
  }

  async function loadDetail(id) {
    const d = await (await fetch("/api/explanations/" + id)).json();
    const diffBlock = d.explanation_diff_html
      ? '<div class="expl-diff"><h3>What changed since you last read this</h3>' +
        '<div class="body">' + d.explanation_diff_html + "</div></div>"
      : "";
    const codeSection = d.code_diff
      ? '<section class="code"><details><summary>What changed in the code</summary><div id="code-diff" class="d2h"></div></details></section>'
      : '<section class="code"><details open><summary>Current code</summary><pre><code id="cur-code"></code></pre></details></section>';
    detailEl.innerHTML =
      "<h2>" + esc(d.symbol) + (d.is_stale ? ' <span class="badge">stale</span>' : "") + "</h2>" +
      '<div class="loc">' + esc(d.repo) + " › " + esc(d.file_path) + "</div>" +
      diffBlock +
      '<div class="prose">' + d.prose_html + "</div>" +
      codeSection;

    if (d.code_diff && window.Diff2HtmlUI) {
      const ui = new window.Diff2HtmlUI(
        document.getElementById("code-diff"),
        d.code_diff,
        {
          drawFileList: false,
          matching: "lines",
          outputFormat: "side-by-side",
          colorScheme: "auto",
        },
        window.hljs,
      );
      ui.draw();
      ui.highlightCode();
    } else if (!d.code_diff) {
      const codeEl = document.getElementById("cur-code");
      codeEl.textContent = d.code_snapshot;
      const lang = langOf(d.file_path);
      if (lang) codeEl.className = "language-" + lang;
      if (window.hljs) window.hljs.highlightElement(codeEl);
    }
  }

  showProjects();
</script>
</body>
</html>
`;
