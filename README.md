# Wise

An out-of-band memory for human-language explanations of code you didn't write by hand.

Most code these days is generated rather than typed, and the one artifact that captures understanding — the chat explanation — disappears into a buried conversation. Wise gives those explanations a durable home: **save an explanation once, pull it up whenever, and have it refresh itself with a diff when the code moves.** Everything lives in a local SQLite store outside your repos, so there are **zero traces in your working tree** — no files, no comments, nothing in `git status`.

It runs as one process: an **MCP server** (over stdio, for Claude Code / the desktop app) plus a **localhost viewer** for reading explanations well. Staleness is detected on read by comparing a structural AST hash — no maintenance loop, no reminders.

## Requirements

- Node ≥ 20
- [pnpm](https://pnpm.io)

## Install & build

```sh
pnpm install
pnpm build
```

This produces `dist/index.js` — the entry for both the MCP server and the viewer.

## Connect it to Claude Code

```sh
claude mcp add wise -- node /absolute/path/to/wise/dist/index.js
```

To keep the store off your real `~/.wise` while trying it out, sandbox it:

```sh
claude mcp add wise --env WISE_DB_PATH=/tmp/wise-test.db -- node /absolute/path/to/wise/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wise": {
      "command": "node",
      "args": ["/absolute/path/to/wise/dist/index.js"]
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
