# Wise

An out-of-band memory for human-language explanations of code you didn't write by hand.

Most code these days is generated rather than typed, and the one artifact that captures understanding — the chat explanation — disappears into a buried conversation. Wise gives those explanations a durable home: **save an explanation once, pull it up whenever, and have it refresh itself with a diff when the code moves.** Everything lives in a local SQLite store outside your repos, so there are **zero traces in your working tree** — no files, no comments, nothing in `git status`.

It runs as one process: an **MCP server** (over stdio, for Claude Code / the desktop app) plus a **localhost viewer** for reading explanations well. Staleness is detected on read by comparing a structural AST hash — no maintenance loop, no reminders.

## Requirements

Node ≥ 22. Nothing else — the package ships prebuilt binaries for its one
native dependency, so there is no compile step and no build toolchain needed.

## Connect it to Claude Code

```sh
claude mcp add wise -- npx -y wise-mcp
```

Run that from inside whichever project you want explanations for. Repeat it per
project; the store itself is shared and lives in `~/.wise`.

To keep the store off your real `~/.wise` while trying it out, point it at a
separate **durable** path (anywhere under your home — never `/tmp`, which macOS
wipes on reboot and after a few days idle):

```sh
claude mcp add wise --env WISE_DB_PATH=$HOME/.wise/test.db -- npx -y wise-mcp
```

## Other MCP clients

Claude Desktop, Cursor, Windsurf, Cline and most MCP-compatible editors take
the same config shape. Check your client's docs for where the file lives.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wise": {
      "command": "npx",
      "args": ["-y", "wise-mcp"]
    }
  }
}
```

## Using it

Three tools are exposed to the agent:

- **`save_explanation`** — after Claude explains a symbol, it stores the prose with a snapshot + structural hash of the code. `{ repo, file, symbol, prose }`.
- **`get_explanation`** — retrieve it later. If the code is unchanged, you get the prose back; if it changed, you get the old explanation, the old code, and the current code, and Claude refreshes it (then saves it back). `{ repo, file, symbol }`.
- **`install_hook`** — opt-in per repo: drops a `post-commit` hook into `.git/hooks/` that flags explanations stale proactively. Nothing else touches `.git/`. `{ repo }`.

In practice: ask Claude to explain something and "remember it with wise," then days later ask what it does — a stale answer arrives as a delta rather than a from-scratch re-read.

## The viewer

While the server is running, open **http://127.0.0.1:4319** to browse explanations: rendered markdown, an explanation diff headline ("what changed since you last read this"), and an expandable side-by-side code diff.

## Configuration

| Env var            | Default          | Purpose                                                    |
| ------------------ | ---------------- | ---------------------------------------------------------- |
| `WISE_HOME`        | `~/.wise`        | Directory holding the store.                               |
| `WISE_DB_PATH`     | `<home>/wise.db` | Full path to the SQLite file (`:memory:` for a throwaway). |
| `WISE_VIEWER_PORT` | `4319`           | Localhost port for the viewer.                             |

The store directory is created on first run. Nothing is ever written to your repositories.

## Development

```sh
pnpm dev          # run from source with tsx (watch)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit (strict)
pnpm lint         # eslint (type-aware)
```

A `lefthook` pre-commit hook runs format, lint, typecheck, and tests.

## Building from source

Only needed to work on wise itself.

```sh
pnpm install
pnpm build          # produces dist/index.js
pnpm test
```

Point your client at the build with `node /absolute/path/to/wise/dist/index.js`
in place of `npx -y wise-mcp`.

Note that a running MCP server keeps the code it started with. After a rebuild,
reconnect the server in your client to pick the change up — inherent to how
stdio MCP servers are launched, not a bug.
