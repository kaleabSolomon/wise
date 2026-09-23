# Wise — editor hover

Hover a symbol, see the explanation you already saved for it.

Wise keeps explanations in a SQLite store outside your repos, so nothing in
your code says what a function does. This extension is the bridge: it asks the
running Wise viewer what is explained at your cursor and shows it in a hover.

## Requires

Wise running. The extension talks to the viewer's HTTP server, which starts
alongside the MCP server, so any editor session with Wise connected already has
one. Nothing to configure if you use the default port.

## What resolves

| File | How |
| --- | --- |
| TypeScript, JavaScript | The declaration containing the cursor. Hover the name, the signature, or anywhere in the body. |
| Anything else | An in-code anchor. Hover the marker line or the declaration directly below it. |

Wise only parses TS and JS, so in other languages it knows exactly where an
anchor sits and nothing more. It could guess by walking up to the nearest
marker, but that answers confidently and wrongly the moment an unanchored
function sits below an anchored one, so it declines instead.

Hovering a **call site** does not resolve. Wise finds declarations at a
position; it does not follow a reference back to where it was defined.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `wise.enabled` | `true` | Turn the hover off without uninstalling. |
| `wise.port` | `4319` | Match this to `WISE_VIEWER_PORT` if you changed it. |

## Running it locally

```sh
pnpm install
pnpm build      # bundles to out/extension.cjs
pnpm test
```

Then press **F5** in this folder to open an Extension Development Host with it
loaded. Open a project that has Wise explanations saved, and hover a symbol you
have explained.

The `.vscode/launch.json` that F5 uses is untracked, because this repo ignores
`.vscode/`. It exists locally; if you want it committed, add
`!extension/.vscode/` to the root `.gitignore`.

## Install

**Cursor, Windsurf, VSCodium, Gitpod** — search for *Wise* in the Extensions
view, or install from [Open VSX](https://open-vsx.org/extension/kaleabSolomon/wise-hover).

**VS Code** — download `wise-hover-<version>.vsix` from the
[latest release](https://github.com/kaleabSolomon/wise/releases), then either
drag it onto the Extensions view or run:

```sh
code --install-extension wise-hover-0.0.1.vsix
```

VS Code only installs from Microsoft's Marketplace or from a local file, so the
`.vsix` is the route there for now.

You also need wise itself running — the extension reads from its local server:

```sh
claude mcp add wise -- npx -y wise-mcp
```

## Developing on it

```sh
pnpm install
pnpm build      # bundles to out/extension.cjs
pnpm test
pnpm package    # builds the .vsix
```

Press **F5** in this folder to open an Extension Development Host with it
loaded. The `.vscode/launch.json` F5 uses is untracked, because this repo
ignores `.vscode/`; add `!extension/.vscode/` to the root `.gitignore` if you
want it committed.

## Quiet by design

Wise not running, the wrong port, no explanation at the cursor, a file outside
any workspace folder: all of these show nothing at all. A hover that raised an
error whenever the server was down would be worse than no extension.
