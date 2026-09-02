/**
 * Wise viewer client. Bundled to `public/app.js` by esbuild (see
 * scripts/build-viewer.mjs). `Diff2HtmlUI` and `hljs` are globals provided by
 * the <script> tags in index.html.
 */
export {};

import { foldableRuns, type FoldRun } from "../fold.js";

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
  anchored: boolean;
  updated_at: number;
}
interface Detail extends Row {
  prose_html: string;
  code_snapshot: string;
  explanation_diff_html: string | null;
  code_diff: string | null;
  anchor: { id: string; present: boolean; file: string | null } | null;
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
      (r.anchored
        ? ' <span class="anchor-dot" title="Anchored">⚓</span>'
        : "") +
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

/*
 * Folding unchanged lines in the code diff.
 *
 * The patch is built with full-file context, so a one-line edit inside a long
 * function still renders the whole function. Runs of unchanged lines far from
 * any change fold behind a click, keeping a few lines of context either side.
 *
 * The two side-by-side tables hold one row per line at matching indices, so a
 * fold has to hide — and mark — the same index range in *both*, or the columns
 * drift out of alignment with each other.
 */

const FOLD_KEY = "wise:collapseDiff";

let foldEnabled = ((): boolean => {
  try {
    return localStorage.getItem(FOLD_KEY) !== "0";
  } catch {
    return true; // localStorage may be unavailable; fold by default
  }
})();

/** Rows of each side's table, index-aligned across sides. */
function sideRows(container: HTMLElement): HTMLElement[][] {
  return [...container.querySelectorAll(".d2h-file-side-diff tbody")].map(
    (body) =>
      [...body.querySelectorAll(":scope > tr")].filter(
        (n): n is HTMLElement => n instanceof HTMLElement,
      ),
  );
}

/** A line is unchanged only when every side agrees it is context. */
function unchangedAt(sides: HTMLElement[][], index: number): boolean {
  return sides.every((rows) => {
    const row = rows[index];
    return (
      row !== undefined &&
      row.querySelector(".d2h-cntx") !== null &&
      // Hunk headers and change rows are never foldable.
      row.querySelector(".d2h-info, .d2h-ins, .d2h-del") === null
    );
  });
}

function foldRuns(sides: HTMLElement[][]): FoldRun[] {
  if (sides.length === 0) return [];
  const total = Math.min(...sides.map((rows) => rows.length));
  const unchanged = Array.from({ length: total }, (_, i) =>
    unchangedAt(sides, i),
  );
  return foldableRuns(unchanged);
}

/** Hide one run in every side, behind a marker row that expands it again. */
function applyFold(sides: HTMLElement[][], run: FoldRun): void {
  const count = run.end - run.start;
  const hidden: HTMLElement[] = [];
  const markers: HTMLElement[] = [];

  for (const rows of sides) {
    const first = rows[run.start];
    if (!first?.parentNode) continue;

    const marker = document.createElement("tr");
    marker.className = "wise-fold";
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = `⋯ ${count} unchanged line${count === 1 ? "" : "s"}`;
    marker.appendChild(cell);
    marker.title = "Show these lines";
    first.parentNode.insertBefore(marker, first);
    markers.push(marker);

    for (let i = run.start; i < run.end; i++) {
      const row = rows[i];
      if (!row) continue;
      row.classList.add("wise-folded");
      hidden.push(row);
    }
  }

  // Expanding is one-way: a fold, once opened, stays open until the diff is
  // redrawn. Re-folding on a second click would move content out from under
  // the pointer the user just aimed at.
  const expand = (): void => {
    for (const row of hidden) row.classList.remove("wise-folded");
    for (const marker of markers) marker.remove();
  };
  for (const marker of markers) marker.addEventListener("click", expand);
}

/** Draw the diff; returns how many runs *could* be folded, fold state aside. */
function drawCodeDiff(patch: string): number {
  const target = el("code-diff");
  target.innerHTML = "";
  if (!window.Diff2HtmlUI) return 0;

  const ui = new window.Diff2HtmlUI(
    target,
    patch,
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

  const sides = sideRows(target);
  const runs = foldRuns(sides);
  if (foldEnabled) for (const run of runs) applyFold(sides, run);
  return runs.length;
}

function wireCodeDiff(patch: string): void {
  const button = document.getElementById("fold-toggle");
  const render = (): void => {
    const foldable = drawCodeDiff(patch);
    if (!button) return;
    button.textContent = foldEnabled ? "Show whole file" : "Collapse unchanged";
    // Nothing long enough to fold — don't offer a control that does nothing.
    button.hidden = foldable === 0;
  };

  button?.addEventListener("click", () => {
    foldEnabled = !foldEnabled;
    try {
      localStorage.setItem(FOLD_KEY, foldEnabled ? "1" : "0");
    } catch {
      /* ignore */
    }
    render();
  });
  render();
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
  const anchorChip = ((): string => {
    if (!d.anchor) return "";
    if (!d.anchor.present) {
      return (
        '<span class="chip chip-warn" title="The marker comment is no longer in the code. ' +
        'This explanation still resolves by name and path, but will not survive a rename or move.">' +
        "anchor missing</span>"
      );
    }
    const moved =
      d.anchor.file && d.anchor.file !== d.file_path
        ? " · " + esc(d.anchor.file)
        : "";
    return (
      '<span class="chip" title="wise:' +
      esc(d.anchor.id) +
      '">anchored' +
      moved +
      "</span>"
    );
  })();

  const codeSection = d.code_diff
    ? '<div class="code-head"><h3 class="code-h">What changed in the code</h3>' +
      '<button class="fold-toggle" id="fold-toggle" hidden></button></div>' +
      '<div id="code-diff" class="d2h"></div>'
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
    anchorChip +
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

  if (d.code_diff) {
    wireCodeDiff(d.code_diff);
  } else {
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
