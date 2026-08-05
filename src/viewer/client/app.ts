/**
 * Wise viewer client. Bundled to `public/app.js` by esbuild (see
 * scripts/build-viewer.mjs). `Diff2HtmlUI` and `hljs` are globals provided by
 * the <script> tags in index.html.
 */
export {};

interface Diff2HtmlUIInstance {
  draw(): void;
  highlightCode(): void;
}
type Diff2HtmlUICtor = new (
  target: HTMLElement,
  diff?: string,
  config?: Record<string, unknown>,
  hljs?: unknown,
) => Diff2HtmlUIInstance;

declare global {
  interface Window {
    Diff2HtmlUI?: Diff2HtmlUICtor;
    hljs?: { highlightElement(el: HTMLElement): void };
  }
}

interface Row {
  id: number;
  repo: string;
  file_path: string;
  symbol: string;
  is_stale: boolean;
  updated_at: number;
}
interface Detail extends Row {
  prose_html: string;
  code_snapshot: string;
  explanation_diff_html: string | null;
  code_diff: string | null;
}

/** Get an element that must exist, or fail loudly instead of silently. */
function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`wise viewer: missing element #${id}`);
  return node;
}

const navEl = el("nav");
const detailEl = el("detail");
let activeId: number | null = null;
let currentRepo: string | null = null;

const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );

const projectName = (repo: string): string =>
  repo.replace(/\/+$/, "").split("/").pop() ?? repo;

const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  css: "css",
  html: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  kt: "kotlin",
  swift: "swift",
};
const langOf = (file: string): string =>
  LANGS[(file.split(".").pop() ?? "").toLowerCase()] ?? "";

// Restore the saved left-column width (set on :root so it survives re-renders).
try {
  const saved = localStorage.getItem("wise:leftWidth");
  if (saved) document.documentElement.style.setProperty("--left-w", saved);
} catch {
  /* localStorage may be unavailable; ignore */
}

async function fetchRows(): Promise<Row[]> {
  const res = await fetch("/api/explanations");
  return (await res.json()) as Row[];
}

function initGutter(): void {
  const gutter = document.getElementById("gutter");
  if (!gutter) return;
  gutter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const cols = document.querySelector(".detail-cols");
    if (!cols) return;
    const rect = cols.getBoundingClientRect();
    gutter.classList.add("dragging");
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(
        260,
        Math.min(ev.clientX - rect.left, rect.width - 340),
      );
      document.documentElement.style.setProperty("--left-w", `${w}px`);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      gutter.classList.remove("dragging");
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(
          "wise:leftWidth",
          getComputedStyle(document.documentElement)
            .getPropertyValue("--left-w")
            .trim(),
        );
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

async function showProjects(): Promise<void> {
  const rows = await fetchRows();
  if (!rows.length) {
    navEl.innerHTML =
      '<div class="nav-head">Wise</div>' +
      '<p class="path" style="padding:0 16px">No explanations yet.</p>';
    return;
  }
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const list = groups.get(r.repo) ?? [];
    list.push(r);
    groups.set(r.repo, list);
  }
  navEl.innerHTML = '<div class="nav-head">Projects</div>';
  for (const [repo, items] of groups) {
    const stale = items.filter((i) => i.is_stale).length;
    const node = document.createElement("div");
    node.className = "item";
    node.innerHTML =
      '<div class="main"><div class="sym">' +
      esc(projectName(repo)) +
      "</div>" +
      '<div class="path">' +
      esc(repo) +
      "</div></div>" +
      '<div class="count">' +
      items.length +
      (stale ? ' · <span class="badge">' + stale + " stale</span>" : "") +
      "</div>";
    node.onclick = () => void showExplanations(repo);
    navEl.appendChild(node);
  }
}

async function showExplanations(repo: string): Promise<void> {
  currentRepo = repo;
  const rows = (await fetchRows()).filter((r) => r.repo === repo);
  navEl.innerHTML =
    '<div class="nav-head"><span class="back">‹ Projects</span></div>' +
    '<div class="nav-head" style="padding-top:0">' +
    esc(projectName(repo)) +
    "</div>";
  navEl
    .querySelector(".back")
    ?.addEventListener("click", () => void showProjects());
  for (const r of rows) {
    const node = document.createElement("div");
    node.className = "item" + (r.id === activeId ? " active" : "");
    node.innerHTML =
      '<div class="main"><div class="sym">' +
      esc(r.symbol) +
      (r.is_stale ? ' <span class="badge">stale</span>' : "") +
      "</div>" +
      '<div class="path">' +
      esc(r.file_path) +
      "</div></div>";
    node.onclick = () => {
      activeId = r.id;
      for (const s of navEl.querySelectorAll(".item"))
        s.classList.remove("active");
      node.classList.add("active");
      void loadDetail(r.id);
    };
    navEl.appendChild(node);
  }
}

async function loadDetail(id: number): Promise<void> {
  const res = await fetch("/api/explanations/" + id);
  const d = (await res.json()) as Detail;

  const diffBlock = d.explanation_diff_html
    ? '<div class="expl-diff"><h3>What changed since you last read this</h3>' +
      '<div class="body">' +
      d.explanation_diff_html +
      "</div></div>"
    : "";
  const codeSection = d.code_diff
    ? '<h3 class="code-h">What changed in the code</h3><div id="code-diff" class="d2h"></div>'
    : '<h3 class="code-h">Current code</h3><pre class="codeblock"><code id="cur-code"></code></pre>';
  detailEl.innerHTML =
    '<div class="detail-head"><h2>' +
    esc(d.symbol) +
    (d.is_stale ? ' <span class="badge">stale</span>' : "") +
    "</h2>" +
    '<div class="actions" id="actions"></div></div>' +
    '<div class="loc">' +
    esc(d.repo) +
    " › " +
    esc(d.file_path) +
    "</div>" +
    '<div class="detail-cols">' +
    '<div class="detail-left">' +
    diffBlock +
    '<div class="prose">' +
    d.prose_html +
    "</div></div>" +
    '<div class="gutter" id="gutter"></div>' +
    '<div class="detail-right">' +
    codeSection +
    "</div></div>";

  if (d.code_diff && window.Diff2HtmlUI) {
    const ui = new window.Diff2HtmlUI(
      el("code-diff"),
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
    const codeEl = el("cur-code");
    codeEl.textContent = d.code_snapshot;
    const lang = langOf(d.file_path);
    if (lang) codeEl.className = "language-" + lang;
    window.hljs?.highlightElement(codeEl);
  }

  wireDelete(id);
  initGutter();
}

function wireDelete(id: number): void {
  const actions = document.getElementById("actions");
  if (!actions) return;
  actions.innerHTML = '<button class="del" id="del-btn">Delete</button>';
  el("del-btn").onclick = () => {
    actions.innerHTML =
      '<span class="confirm-q">Delete this explanation?</span>' +
      '<button class="del danger" id="del-yes">Delete</button>' +
      '<button class="del" id="del-no">Cancel</button>';
    el("del-no").onclick = () => wireDelete(id);
    el("del-yes").onclick = () =>
      void (async () => {
        const res = await fetch("/api/explanations/" + id, {
          method: "DELETE",
        });
        if (!res.ok) return;
        activeId = null;
        detailEl.innerHTML = '<p class="empty">Explanation deleted.</p>';
        const rows = await fetchRows();
        if (currentRepo && rows.some((r) => r.repo === currentRepo)) {
          void showExplanations(currentRepo);
        } else {
          void showProjects();
        }
      })();
  };
}

void showProjects();
