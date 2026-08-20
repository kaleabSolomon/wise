import { describe, it, expect } from "vitest";
import { describeViewerError, DEFAULT_VIEWER_PORT } from "./boot.js";

describe("describeViewerError", () => {
  it("names the duplicate-process cause when the port is taken", () => {
    const err = Object.assign(
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:4319"),
      { code: "EADDRINUSE" },
    );
    const text = describeViewerError(err, DEFAULT_VIEWER_PORT);

    expect(text).toContain("already in use");
    expect(text).toContain("another wise process");
    // The consequence is the part worth saying out loud: the page in the
    // browser is served by the *other* process, so edits here won't show up.
    expect(text).toContain("may be running older code");
    expect(text).toContain("WISE_VIEWER_PORT");
    expect(text).toContain(String(DEFAULT_VIEWER_PORT));
  });

  it("reports the port it actually tried, not the default", () => {
    const err = Object.assign(new Error("nope"), { code: "EADDRINUSE" });
    expect(describeViewerError(err, 9999)).toContain("9999");
  });

  it("falls back to the raw error for any other failure", () => {
    const err = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const text = describeViewerError(err, DEFAULT_VIEWER_PORT);

    expect(text).toContain("not started");
    expect(text).toContain("permission denied");
    expect(text).not.toContain("another wise process");
  });

  it("handles a thrown value that isn't an Error at all", () => {
    expect(describeViewerError("boom", DEFAULT_VIEWER_PORT)).toContain("boom");
    expect(describeViewerError(undefined, DEFAULT_VIEWER_PORT)).toContain(
      "not started",
    );
  });
});
