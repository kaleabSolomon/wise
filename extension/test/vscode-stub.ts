/**
 * Stand-in for the VS Code API.
 *
 * Only the surface the extension actually touches. Anything it starts using
 * without this being updated will throw in tests, which is the intent: a
 * silent stub would let the extension drift away from the real API unnoticed.
 */

export const state: {
  config: Record<string, unknown>;
  folder: { uri: { fsPath: string } } | undefined;
  registered: Array<{ selector: unknown; provider: unknown }>;
} = {
  config: { enabled: true, port: 4319 },
  folder: { uri: { fsPath: "/repo" } },
  registered: [],
};

export function reset(): void {
  state.config = { enabled: true, port: 4319 };
  state.folder = { uri: { fsPath: "/repo" } };
  state.registered = [];
}

export class MarkdownString {
  value = "";
  isTrusted = false;
  supportHtml = false;
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class Hover {
  /**
   * An array, because the real API normalizes to one however you construct it.
   * Keeping the stub's shape honest is what lets `tsc` catch drift.
   */
  contents: MarkdownString[];
  constructor(contents: MarkdownString | MarkdownString[]) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export const workspace = {
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback: T): T =>
      section === "wise" && key in state.config
        ? (state.config[key] as T)
        : fallback,
  }),
  getWorkspaceFolder: () => state.folder,
};

export const languages = {
  registerHoverProvider: (selector: unknown, provider: unknown) => {
    state.registered.push({ selector, provider });
    return { dispose: () => undefined };
  },
};
