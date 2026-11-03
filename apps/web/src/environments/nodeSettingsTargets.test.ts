import { describe, expect, it, vi } from "vite-plus/test";

const roles = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

vi.mock("./nodeRole", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nodeRole")>()),
  subscribeNodeRoles: (listener: () => void) => {
    roles.listeners.add(listener);
    return () => roles.listeners.delete(listener);
  },
}));

import { EnvironmentId } from "@ryco/contracts";

import { subscribeNodeSettingsTargets } from "./nodeSettingsTargets";

describe("node settings targets", () => {
  it("tell their listeners when this client's role on a node changes", () => {
    const listener = vi.fn();
    const stop = subscribeNodeSettingsTargets([EnvironmentId.make("env-a")], listener);
    expect(roles.listeners.size).toBe(1);
    // The primary's role arrives as a client's: rows read write access again.
    for (const notify of roles.listeners) notify();
    expect(listener).toHaveBeenCalled();
    stop();
    expect(roles.listeners.size).toBe(0);
  });
});
