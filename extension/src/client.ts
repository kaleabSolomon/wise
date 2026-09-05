/**
 * Talking to the local Wise viewer.
 *
 * Wise's MCP server speaks stdio and is bound to whichever agent launched it,
 * so an editor cannot reach it that way. The viewer's HTTP server, which runs
 * in the same process, is the integration surface.
 *
 * Every failure here is silent by design. Wise not running, a wrong port, a
 * cancelled hover: all of them mean "no explanation to show", and a hover that
 * pops an error whenever the server is down would be worse than no extension.
 */

import * as vscode from "vscode";

/** Mirrors `AtResult` in src/tools/at.ts. */
export type AtResult =
  | { found: false }
  | {
      found: true;
      id: number;
      symbol: string;
      file: string;
      /** The whole explanation. */
      prose: string;
      /** Its opening paragraph, which is all a hover has room for. */
      summary: string;
      is_stale: boolean;
      via: "symbol" | "anchor";
    };

export interface AtQuery {
  /** Absolute path to the workspace folder. */
  repo: string;
  /** Absolute path to the file. Wise makes it repo-relative itself. */
  file: string;
  /** 1-based, which is what Wise expects and what editors show. */
  line: number;
}

function viewerOrigin(): string {
  const port = vscode.workspace
    .getConfiguration("wise")
    .get<number>("port", 4319);
  return `http://127.0.0.1:${port}`;
}

/** Deep link to one explanation in the viewer. */
export function viewerUrlFor(id: number): string {
  return `${viewerOrigin()}/#e/${id}`;
}

export function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("wise").get<boolean>("enabled", true);
}

/**
 * Ask what is explained at a position. Resolves to `undefined` when there is
 * nothing to show or nothing to ask.
 */
export async function explanationAt(
  query: AtQuery,
  token: vscode.CancellationToken,
): Promise<AtResult | undefined> {
  const params = new URLSearchParams({
    repo: query.repo,
    file: query.file,
    line: String(query.line),
  });

  // Hovers fire constantly and are cancelled as often; drop the request the
  // moment the editor loses interest rather than finishing work nobody wants.
  const controller = new AbortController();
  const cancelled = token.onCancellationRequested(() => controller.abort());

  try {
    const res = await fetch(`${viewerOrigin()}/api/at?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return (await res.json()) as AtResult;
  } catch {
    return undefined;
  } finally {
    cancelled.dispose();
  }
}
