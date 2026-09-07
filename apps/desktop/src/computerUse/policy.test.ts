import { describe, expect, it, vi } from "vitest";
import type { ComputerUsePolicy, ComputerUseRequest } from "@ryco/contracts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "./policy.ts";

const request = (turnId = "turn-1"): ComputerUseRequest => ({
  sessionId: "session-1",
  threadId: "thread-1",
  turnId,
  tool: "computer",
  args: { action: "observe" },
});
const ok = { content: [{ type: "text" as const, text: "ok" }] };
function setup(patch: Partial<ComputerUsePolicy> = {}) {
  const consent = vi.fn(async () => "once" as const);
  const persist = vi.fn();
  const cancel = vi.fn();
  const controller = new ComputerPolicyController({
    policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true, ...patch },
    consent,
    persist,
    cancel,
    activity: vi.fn(),
  });
  const execute = (
    run: Parameters<typeof controller.execute>[2],
    turn = "turn-1",
    signal = new AbortController().signal,
  ) => controller.execute(request(turn), signal, run);
  return { controller, consent, persist, cancel, execute };
}

describe("computer-use policy", () => {
  it("defaults to disabled and does not run an operation", async () => {
    const { execute } = setup({ enabled: false });
    const run = vi.fn(async () => ok);
    await expect(execute(run)).rejects.toThrow("disabled");
    expect(run).not.toHaveBeenCalled();
  });
  it("blocks app content before consent or execution", async () => {
    const { execute, consent } = setup({ apps: { "/Apps/Private.app": "block" } });
    await expect(
      execute(async (context) => {
        await context.authorizeApp("/Apps/Private.app", "Private");
        return ok;
      }),
    ).rejects.toThrow("blocked");
    expect(consent).not.toHaveBeenCalled();
  });
  it.each([
    "/Applications/Google Chrome.app",
    "C:\\Program Files\\Chrome\\chrome.exe",
    "browser:chrome",
  ])("shares native and extension denial for %s", async (id) => {
    const { execute, consent } = setup({ apps: { [id]: "block" } });
    await expect(
      execute(async (context) => {
        await context.authorizeApp("browser:chrome", "Chrome");
        return ok;
      }),
    ).rejects.toThrow("blocked");
    expect(consent).not.toHaveBeenCalled();
  });
  it("does not let native input bypass a browser denial", async () => {
    const { execute } = setup({ apps: { "browser:brave": "block" } });
    await expect(
      execute(async (context) => {
        await context.authorizeApp("/Applications/Brave Browser.app", "Brave");
        return ok;
      }),
    ).rejects.toThrow("blocked");
  });
  it("remembers once consent only for the exact turn", async () => {
    const { execute, consent } = setup();
    const run: Parameters<typeof execute>[0] = async (context) => {
      await context.authorizeApp("test.app", "Test");
      return ok;
    };
    await execute(run);
    await execute(run);
    expect(consent).toHaveBeenCalledTimes(1);
    await execute(run, "turn-2");
    expect(consent).toHaveBeenCalledTimes(2);
  });
  it("requires explicit foreground permission even for an allowed app", async () => {
    const { execute, consent } = setup({ apps: { app: "allow" } });
    await expect(
      execute(async (context) => {
        await context.authorizeApp("app", "App");
        await context.authorizeForeground();
        return ok;
      }),
    ).rejects.toThrow("Foreground takeover is disabled");
    expect(consent).not.toHaveBeenCalled();
  });
  it("revalidates consent after permission revocation", async () => {
    let approve!: (value: "once") => void;
    const controller = new ComputerPolicyController({
      policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true },
      consent: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
      persist: vi.fn(),
      cancel: vi.fn(),
      activity: vi.fn(),
    });
    const action = vi.fn();
    const pending = controller.execute(request(), new AbortController().signal, async (context) => {
      await context.authorizeApp("app", "App");
      action();
      return ok;
    });
    await vi.waitFor(() => expect(approve).toBeDefined());
    controller.update({ ...DEFAULT_COMPUTER_POLICY, enabled: false });
    approve("once");
    await expect(pending).rejects.toThrow("stopped");
    expect(action).not.toHaveBeenCalled();
  });
  it("stops an idle turn and prevents it from reacquiring control", async () => {
    const { execute, controller } = setup();
    await execute(async () => ok);
    controller.stop();
    await expect(execute(async () => ok)).rejects.toThrow("stopped");
    await expect(execute(async () => ok, "turn-2")).resolves.toEqual(ok);
  });
  it("does not revive stopped turns after many subsequent turns", async () => {
    const { execute, controller } = setup();
    await execute(async () => ok);
    controller.stop();
    for (let index = 0; index < 2_010; index++) await execute(async () => ok, `later-${index}`);
    await expect(execute(async () => ok)).rejects.toThrow("stopped");
  });
  it("keeps opaque session and turn identifiers distinct", async () => {
    const { controller } = setup();
    const first = { ...request("c"), sessionId: "a:b" };
    await controller.execute(first, new AbortController().signal, async () => ok);
    controller.stop();
    await expect(
      controller.execute(
        { ...request("b:c"), sessionId: "a" },
        new AbortController().signal,
        async () => ok,
      ),
    ).resolves.toEqual(ok);
  });
  it("fences queued work and discards results after cancellation", async () => {
    const { execute, controller } = setup();
    let finish!: () => void;
    const first = execute(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return ok;
    });
    const queued = vi.fn(async () => ok);
    const second = execute(queued, "turn-2");
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.stop();
    finish();
    await expect(first).rejects.toThrow("stopped");
    await expect(second).rejects.toThrow("stopped");
    expect(queued).not.toHaveBeenCalled();
  });
  it("refuses competing turns on the same target until release", async () => {
    const { execute, controller } = setup();
    const run: Parameters<typeof execute>[0] = async (context) => {
      context.claim("window:42");
      return ok;
    };
    await execute(run);
    await expect(execute(run, "turn-2")).rejects.toThrow("Another Ryco turn");
    await controller.execute(
      { ...request(), args: { action: "release" } },
      new AbortController().signal,
      async () => ok,
    );
    await expect(execute(run, "turn-2")).resolves.toEqual(ok);
  });
  it("keeps persisted state authoritative when saving fails", () => {
    const { controller, persist } = setup();
    persist.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => controller.update(DEFAULT_COMPUTER_POLICY)).toThrow("disk full");
    expect(controller.policy.enabled).toBe(true);
  });
});
