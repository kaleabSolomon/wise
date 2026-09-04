/**
 * Registered for every file-backed document rather than a language list.
 * Wise decides what it can resolve: TypeScript and JavaScript by symbol, any
 * other language by in-code anchor. Enumerating languages here would mean
 * keeping two lists in step and silently dropping anchored files in languages
 * nobody thought to add.
 */

import * as vscode from "vscode";
import { explanationAt, isEnabled, type AtResult } from "./client.js";

/** Every file on disk; Wise answers `found: false` for the rest. */
export const WISE_SELECTOR: vscode.DocumentSelector = { scheme: "file" };

function render(result: Extract<AtResult, { found: true }>): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  // The prose is the user's own text, saved by their agent. Rendering it as
  // trusted markdown would let stored text run commands from a hover.
  md.isTrusted = false;
  md.supportHtml = false;

  const stale = result.is_stale ? "  ·  $(warning) stale" : "";
  md.appendMarkdown(`**${result.symbol}**${stale}\n\n`);
  md.appendMarkdown(result.prose);
  return md;
}

export function createHoverProvider(): vscode.HoverProvider {
  return {
    async provideHover(document, position, token) {
      if (!isEnabled()) return undefined;

      // Wise keys explanations by repository root, so a file with no
      // workspace folder has nothing to look up against.
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return undefined;

      const result = await explanationAt(
        {
          repo: folder.uri.fsPath,
          file: document.uri.fsPath,
          line: position.line + 1, // VS Code counts lines from zero.
        },
        token,
      );

      if (!result?.found) return undefined;
      return new vscode.Hover(render(result));
    },
  };
}
