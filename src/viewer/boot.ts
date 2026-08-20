/**
 * Booting the localhost viewer alongside the MCP server.
 *
 * Kept out of `index.ts` so the failure messages below can be tested without
 * importing the entry point, which starts a server the moment it loads.
 */

import { serve } from "@hono/node-server";
import type { DB } from "../store/db.js";
import { createViewerApp } from "./server.js";

export const DEFAULT_VIEWER_PORT = 4319;

export function viewerPort(): number {
  return Number(process.env["WISE_VIEWER_PORT"] ?? DEFAULT_VIEWER_PORT);
}

/** The `code` of a Node system error, when there is one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === "string" ? code : undefined;
}

/**
 * Explain a viewer bind failure.
 *
 * A busy port almost always means a second wise process is already running —
 * a stale server, or another MCP client holding its own session. The generic
 * "listen EADDRINUSE" reads as noise, so it gets named: the viewer in the
 * browser belongs to that *other* process, which is why edits to this one
 * appear to do nothing.
 */
export function describeViewerError(err: unknown, port: number): string {
  if (errorCode(err) === "EADDRINUSE") {
    return [
      `wise viewer: port ${port} is already in use — another wise process is serving it.`,
      `  This process's MCP tools work normally, but http://127.0.0.1:${port} belongs to that other process and may be running older code.`,
      `  Stop the other process, or set WISE_VIEWER_PORT to a free port.`,
    ].join("\n");
  }
  return `wise viewer: not started (${String(err)})`;
}

/**
 * Start the viewer. Bind failures are logged, never fatal — the MCP server has
 * to keep working. All logging goes to stderr so it can't corrupt the stdio
 * JSON-RPC stream.
 */
export function startViewer(db: DB, port: number = viewerPort()): void {
  const server = serve(
    { fetch: createViewerApp(db).fetch, port, hostname: "127.0.0.1" },
    (info) => console.error(`wise viewer: http://127.0.0.1:${info.port}`),
  );
  server.on("error", (err: unknown) =>
    console.error(describeViewerError(err, port)),
  );
}
