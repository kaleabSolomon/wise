#!/usr/bin/env node
/**
 * Wise — entry point.
 *
 * One process runs both:
 *   - the MCP server (over stdio) for Claude Code / desktop
 *   - the localhost HTTP viewer for reading explanations
 */

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./store/db.js";
import { saveExplanationShape, runSave } from "./tools/save.js";
import { getExplanationShape, runGet, renderGetResult } from "./tools/get.js";
import { flagStaleForHead } from "./hook/flag.js";

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

  // TODO(Section 4): register install_hook.
  // TODO(Section 5): boot the localhost viewer.

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
    const { flagged } = flagStaleForHead(openDb(), resolve(repoArg));
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
