/**
 * Entry point. Registers the hover provider and nothing else yet.
 */

import * as vscode from "vscode";
import { createHoverProvider, WISE_SELECTOR } from "./hover.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      WISE_SELECTOR,
      createHoverProvider(),
    ),
  );
}

export function deactivate(): void {
  // Nothing to tear down: the hover provider is disposed via subscriptions,
  // and the extension holds no connection of its own.
}
