#!/usr/bin/env node
/**
 * Wise — entry point.
 *
 * One process runs both:
 *   - the MCP server (over stdio) for Claude Code / desktop
 *   - the localhost HTTP viewer for reading explanations
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./store/db.js";
import { saveExplanationShape, runSave } from "./tools/save.js";
import { getExplanationShape, runGet, renderGetResult } from "./tools/get.js";
import { installHookShape, runInstallHook } from "./tools/installHook.js";
import {
  setAnchorsShape,
  runSetAnchors,
  anchorsState,
} from "./tools/anchors.js";
import { runUnanchor } from "./tools/unanchor.js";
import { flagStaleForHead } from "./hook/flag.js";
import { canonicalize } from "./store/locator.js";
import { startViewer } from "./viewer/boot.js";

/**
 * Advertised to the client on connect. Tool descriptions say what each verb
 * does; this says when to reach for them — the part a client can't infer from
 * three schemas, and the reason a remembered explanation gets re-derived from
 * scratch instead of retrieved.
 */
const SERVER_INSTRUCTIONS = [
  "Wise is a memory for plain-language explanations of code, kept outside the user's repos.",
  "",
  "Before explaining a symbol the user asks about, call get_explanation — it may already be remembered, and re-deriving an explanation the user already has wastes their time.",
  "",
  "get_explanation returns one of three things:",
  "  - the stored prose, when the code is unchanged — use it as-is;",
  "  - STALE refresh materials (previous explanation, code as it was, code as it is) — write the updated explanation from those, note what changed, and call save_explanation with it;",
  "  - nothing stored — explain the symbol, then save it.",
  "",
  "After writing an explanation worth keeping, call save_explanation. It is an upsert: re-saving the same symbol replaces the current explanation and keeps the previous one in history, so saving again is always safe.",
  "",
  "Locators are (repo, file, symbol): repo is the absolute repository root; file may be repo-relative or absolute (both are stored canonically, so either is fine); symbol is a top-level name, or Class.member for a method, property, or accessor.",
  "",
  "Wise never writes to the user's repository. install_hook is the one exception, and it is opt-in and touches only .git/hooks/.",
  "",
  'In-code anchors (opt-in per repo, off by default): when a repo has them enabled, save_explanation returns a short marker such as "wise:7f3a9c2e" together with the symbol and file it belongs to. Add a comment containing that marker on the line directly above the declaration, in whatever comment syntax the file uses. Wise cannot place it itself — this is the one edit it asks you to make, and the marker is what lets an explanation survive the symbol being renamed or the file being moved. It is never required: skip it, or delete it later, and wise falls back to matching by name and path.',
].join("\n");

async function runServer(): Promise<void> {
  const db = openDb();
  const server = new McpServer(
    { name: "wise", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "save_explanation",
    {
      title: "Save explanation",
      description:
        "Store a human-language explanation for a code symbol. Wise snapshots " +
        "the symbol's current code and a structural hash so it can tell later " +
        "when the explanation has gone stale. Upsert: re-saving a symbol " +
        "replaces its explanation and keeps the previous one in history.",
      inputSchema: saveExplanationShape,
    },
    (args) => {
      const result = runSave(db, args);
      return {
        content: [{ type: "text", text: result.message }],
        isError: !result.ok,
      };
    },
  );

  server.registerTool(
    "get_explanation",
    {
      title: "Get explanation",
      description:
        "Retrieve the stored explanation for a code symbol. Call this before " +
        "explaining a symbol — it may already be remembered. Wise re-reads the " +
        "symbol and compares a structural hash: if fresh, it returns the prose; " +
        "if the code changed, it returns the old explanation, the old code, and " +
        "the current code so you can refresh it and call save_explanation back.",
      inputSchema: getExplanationShape,
    },
    (args) => {
      const { text, isError } = renderGetResult(runGet(db, args));
      return { content: [{ type: "text", text }], isError };
    },
  );

  server.registerTool(
    "install_hook",
    {
      title: "Install post-commit hook",
      description:
        "Opt-in: install a post-commit hook into one repository's .git/hooks/ " +
        "so explanations are flagged stale proactively after each commit. " +
        "Nothing is placed in the working tree. Refuses to overwrite a " +
        "non-wise post-commit hook.",
      inputSchema: installHookShape,
    },
    (args) => {
      const wiring = {
        node: process.execPath,
        entry: fileURLToPath(import.meta.url),
      };
      const r = runInstallHook(args, wiring);
      const text = r.ok
        ? `Wise post-commit hook ${r.action} at ${r.hookPath}.`
        : r.message;
      return { content: [{ type: "text", text }], isError: !r.ok };
    },
  );

  server.registerTool(
    "set_repo_anchors",
    {
      title: "Enable or disable in-code anchors",
      description:
        "Opt one repository in to in-code anchors. When on, each newly saved " +
        "explanation is given a short marker comment for you to add above the " +
        "symbol, so the explanation survives renames and file moves. Wise " +
        "never edits the repo itself; it tells you the marker to place. Off " +
        "by default, and reversible at any time.",
      inputSchema: setAnchorsShape,
    },
    (args) => {
      const r = runSetAnchors(db, args);
      return { content: [{ type: "text", text: r.message }] };
    },
  );

  startViewer(db);

  await server.connect(new StdioServerTransport());
}

/**
 * `wise hook-flag <repo>` — invoked by the installed post-commit hook, out of
 * band from the stdio server. A post-commit hook must never disrupt a commit,
 * so any failure is reported and swallowed.
 */
function runHookFlag(repoArg: string | undefined): void {
  if (!repoArg) {
    console.error("usage: wise hook-flag <repo>");
    process.exitCode = 2;
    return;
  }
  try {
    // Same canonical form the store keys by — see store/locator.ts.
    const { flagged } = flagStaleForHead(openDb(), canonicalize(repoArg));
    console.error(`wise: flagged ${flagged} explanation(s) stale`);
  } catch (err) {
    console.error(`wise: hook-flag failed: ${String(err)}`);
  }
}

/** `wise anchors on|off|status <repo>` — the CLI face of `set_repo_anchors`. */
function runAnchorsCli(
  mode: string | undefined,
  repoArg: string | undefined,
): void {
  if (!repoArg || !mode || !["on", "off", "status"].includes(mode)) {
    console.error("usage: wise anchors on|off|status <repo>");
    process.exitCode = 2;
    return;
  }
  const db = openDb();
  if (mode === "status") {
    const on = anchorsState(db, repoArg);
    console.error(
      `wise: in-code anchors are ${on ? "ON" : "OFF"} for ${canonicalize(repoArg)}`,
    );
    return;
  }
  console.error(
    runSetAnchors(db, { repo: repoArg, enabled: mode === "on" }).message,
  );
}

/**
 * `wise unanchor <repo> [--apply]` — strip wise's markers back out.
 *
 * Deliberately CLI-only and dry by default: this is the one command that edits
 * the user's files, so it shows what it would do until told otherwise. It is
 * not an MCP tool — removing traces should not need an agent.
 */
function runUnanchorCli(repoArg: string | undefined, flags: string[]): void {
  if (!repoArg) {
    console.error("usage: wise unanchor <repo> [--apply]");
    process.exitCode = 2;
    return;
  }
  const apply = flags.includes("--apply");
  console.error(runUnanchor(openDb(), repoArg, { apply }).message);
}

const argv = process.argv.slice(2);
if (argv[0] === "hook-flag") {
  runHookFlag(argv[1]);
} else if (argv[0] === "anchors") {
  runAnchorsCli(argv[1], argv[2]);
} else if (argv[0] === "unanchor") {
  runUnanchorCli(argv[1], argv.slice(2));
} else {
  runServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
