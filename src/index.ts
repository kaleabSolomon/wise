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
import { serve } from "@hono/node-server";
import { openDb, type DB } from "./store/db.js";
import { saveExplanationShape, runSave } from "./tools/save.js";
import { getExplanationShape, runGet, renderGetResult } from "./tools/get.js";
import { installHookShape, runInstallHook } from "./tools/installHook.js";
import { flagStaleForHead } from "./hook/flag.js";
import { canonicalize } from "./store/locator.js";
import { createViewerApp } from "./viewer/server.js";

const VIEWER_PORT = Number(process.env["WISE_VIEWER_PORT"] ?? 4319);

/**
 * Start the localhost viewer. Bind failures (e.g. another wise process already
 * holds the port) are logged, never fatal — the MCP server must keep working.
 * All logging goes to stderr so it can't corrupt the stdio JSON-RPC stream.
 */
function startViewer(db: DB): void {
  const server = serve(
    {
      fetch: createViewerApp(db).fetch,
      port: VIEWER_PORT,
      hostname: "127.0.0.1",
    },
    (info) => console.error(`wise viewer: http://127.0.0.1:${info.port}`),
  );
  server.on("error", (err: unknown) =>
    console.error(`wise viewer: not started (${String(err)})`),
  );
}

async function runServer(): Promise<void> {
  const db = openDb();
  const server = new McpServer({ name: "wise", version: "0.1.0" });

  server.registerTool(
    "save_explanation",
    {
      title: "Save explanation",
      description:
        "Store a human-language explanation for a code symbol. Wise snapshots " +
        "the symbol's current code and a structural hash so it can tell later " +
        "when the explanation has gone stale.",
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
        "Retrieve the stored explanation for a code symbol. Wise re-reads the " +
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

const argv = process.argv.slice(2);
if (argv[0] === "hook-flag") {
  runHookFlag(argv[1]);
} else {
  runServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
