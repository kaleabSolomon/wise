#!/usr/bin/env node
/**
 * Wise — entry point.
 *
 * One process runs both:
 *   - the MCP server (over stdio) for Claude Code / desktop
 *   - the localhost HTTP viewer for reading explanations
 *
 * Section 0 stub: this boots and logs. Wiring lands in Section 3 (MCP server)
 * and Section 5 (viewer).
 */

// Becomes async in Section 3 once the MCP server and viewer are awaited here.
function main(): void {
  // TODO(Section 3): start the MCP server over stdio.
  // TODO(Section 5): start the localhost viewer.
  console.error("wise: scaffold booted (no tools wired yet)");
}

main();
