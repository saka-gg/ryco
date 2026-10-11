import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installHostedConsoleBoundary, resetHostedConsoleBoundaryForTests } from "./logging.ts";

const originals = {
  debug: console.debug,
  error: console.error,
  info: console.info,
  log: console.log,
  warn: console.warn,
};

afterEach(() => {
  resetHostedConsoleBoundaryForTests();
  Object.assign(console, originals);
});

describe("hosted console boundary", () => {
  it.each(["debug", "error", "info", "log", "warn"] as const)(
    "drops sensitive values before console.%s or a crash collector can receive them",
    (method) => {
      const collector = vi.fn();
      console[method] = collector;
      installHostedConsoleBoundary();
      console[method]("credential-sensitive-canary", { relayPayload: "payload-sensitive-canary" });
      expect(collector).not.toHaveBeenCalled();
    },
  );

  it("restores every original console method after the hosted boundary is reset", () => {
    const spies = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    };
    Object.assign(console, spies);

    installHostedConsoleBoundary();
    resetHostedConsoleBoundaryForTests();

    expect(console.debug).toBe(spies.debug);
    expect(console.error).toBe(spies.error);
    expect(console.info).toBe(spies.info);
    expect(console.log).toBe(spies.log);
    expect(console.warn).toBe(spies.warn);
  });
});
