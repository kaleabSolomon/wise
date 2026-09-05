import { describe, it, expect, beforeEach } from "vitest";
import { activate, deactivate } from "../src/extension.js";
import { state, reset } from "./vscode-stub.js";

beforeEach(reset);

describe("activate", () => {
  it("registers one hover provider and hands it to the host for disposal", () => {
    // The subscriptions array is how the host tears an extension down; a
    // provider missing from it would outlive the extension.
    const subscriptions: unknown[] = [];
    activate({ subscriptions } as never);

    expect(state.registered).toHaveLength(1);
    expect(subscriptions).toHaveLength(1);
  });

  it("deactivates without throwing", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
