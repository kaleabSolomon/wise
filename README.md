# Wise

An out-of-band memory for human-language explanations of code you didn't write by hand.

Most code these days is generated rather than typed, and the one artifact that captures understanding — the chat explanation — disappears into a buried conversation. Wise gives those explanations a durable home: **save an explanation once, pull it up whenever, and have it refresh itself with a diff when the code moves.** Everything lives in a local SQLite store outside your repos, so there are **zero traces in your working tree** — no files, no comments, nothing in `git status`.

It runs as one process: an **MCP server** (over stdio, for Claude Code / the desktop app) plus a **localhost viewer** for reading explanations well. Staleness is detected on read by comparing a structural AST hash — no maintenance loop, no reminders.
