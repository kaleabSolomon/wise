import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { openDb } from "./db.js";

describe("openDb — ephemeral-path warning", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created) {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(p + suffix, { force: true });
      }
    }
    created.length = 0;
    vi.restoreAllMocks();
  });

  it("warns when the store is under a temp directory", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = `/tmp/wise-ephemeral-test-${process.pid}.db`;
    created.push(path);

    openDb(path).close();

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("will not persist");
  });

  it("does not warn for a durable or in-memory store", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    openDb(":memory:").close();
    expect(spy).not.toHaveBeenCalled();
  });
});
