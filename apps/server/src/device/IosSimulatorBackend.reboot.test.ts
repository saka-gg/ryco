import { describe, expect, it, vi } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { IosSimulatorBackend, isStaleDescriptorError, textChunks } from "./IosSimulatorBackend.ts";
import { HelperClient } from "./helperClient.ts";

const DEVICE = "AAAA-1111";

function simctlResult(stdout: string, code = 0): ProcessRunResult {
  return { stdout, stderr: "", code, signal: null, timedOut: false };
}

const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: DEVICE, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
    ],
  },
});

/** The helper's non-delivery error, around the bridge's `undeliveredReason`. */
const undelivered = (reason: string, dropped = 1): string =>
  `${dropped} HID event(s) were not delivered to the simulator: ${reason}; inspect the screen before another input`;

/**
 * Stands in for the helper process. It models the one behavior this defect is
 * about: an attachment is bound to a boot generation, and a descriptor from a
 * previous boot fails the way the real helper fails.
 */
class FakeHelper {
  attachCalls: Array<{ readonly udid: string; readonly force: boolean }> = [];
  /** Bumped by the test to simulate the simulator rebooting underneath us. */
  bootGeneration = 1;
  running = true;
  /** What `attach` reports as the input transport; null keeps the log quiet. */
  inputTransport: "dtuhid" | "indigo" | null = null;

  private attachment: { udid: string; generation: number } | null = null;

  get attachedDevice() {
    return this.attachment === null
      ? null
      : {
          udid: this.attachment.udid,
          pointWidth: 393,
          pointHeight: 852,
          pixelWidth: 1179,
          pixelHeight: 2556,
          scale: 3,
          inputAvailable: true,
          accessibilityAvailable: true,
          inputTransport: this.inputTransport,
        };
  }

  start(): void {}

  invalidateAttachment(udid: string): void {
    if (this.attachment?.udid === udid) this.attachment = null;
  }

  async attach(udid: string, options: { readonly force?: boolean } = {}) {
    this.attachCalls.push({ udid, force: options.force === true });
    if (!options.force && this.attachment?.udid === udid) {
      if (this.attachment.generation !== this.bootGeneration) {
        throw new Error("display has no framebuffer surface yet");
      }
      return this.attachedDevice!;
    }
    this.attachment = { udid, generation: this.bootGeneration };
    return this.attachedDevice!;
  }

  /** Set by a test to make the next N injections report that nothing was sent. */
  undeliverableCalls = 0;
  /** What the next requests do, in order: fail with the message, or succeed (null). */
  failures: Array<string | null> = [];
  requestCalls: string[] = [];
  requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];

  /** How long each request takes, so concurrent calls can overlap. */
  requestDelayMs = 0;

  async request(method = "unknown", params: Record<string, unknown> = {}) {
    this.requestCalls.push(method);
    this.requests.push({ method, params });
    if (this.requestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.requestDelayMs));
    }
    if (this.attachment === null) throw new Error("not attached");
    if (this.attachment.generation !== this.bootGeneration) {
      throw new Error("display has no framebuffer surface yet");
    }
    if (this.undeliverableCalls > 0) {
      this.undeliverableCalls -= 1;
      throw new Error(undelivered("nothing was sent: input was not delivered"));
    }
    const failure = this.failures.shift();
    if (typeof failure === "string") throw new Error(failure);
    return { ok: true };
  }

  normalize(x: number, y: number) {
    return { x: x / 393, y: y / 852 };
  }

  async startStream() {}
  async stopStream() {}
  async dispose() {}
}

function makeBackend() {
  const helper = new FakeHelper();
  return { backend: backendWith(() => helper as unknown as HelperClient), helper };
}

function backendWith(makeHelperClient: () => HelperClient) {
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    helperCacheRoot: "/tmp/ryco-device-test-cache",
    makeHelperClient,
    run: async (command, args) => {
      if (command === "xcrun" && args[1] === "list") return simctlResult(DEVICE_LIST_JSON);
      if (command === "xcodebuild") return simctlResult("Xcode 26.2\nBuild version 17C52");
      return simctlResult("");
    },
  });
  // The helper is normally compiled on first attach; the fake stands in for the
  // compiled binary so these tests never touch the toolchain.
  Object.defineProperty(backend, "compileHelperIfNeeded", {
    value: async () => "/tmp/ryco-device-test-cache/ryco-device-helper",
  });
  return backend;
}

/**
 * A helper process that works like the real one where devices are concerned:
 * one request at a time in arrival order, one attachment, and input methods that
 * take no udid and act on whatever is attached. It logs where each input landed.
 */
const FAKE_HELPER_SOURCE = `
let attached = null;
const log = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function handle({ method, params }) {
  if (method === "attach") {
    await wait(30);
    attached = params.udid;
    return { pointWidth: 393, pointHeight: 852, pixelWidth: 1179, pixelHeight: 2556, scale: 3 };
  }
  if (method === "log") return { log };
  await wait(5);
  log.push(method + "->" + attached);
  return { ok: true };
}
let queue = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\\n"); newline !== -1; newline = buffer.indexOf("\\n")) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    queue = queue.then(async () => {
      const result = await handle(request);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    });
  }
});
`;

function makeBackendWithHelperProcess() {
  const clients: HelperClient[] = [];
  const backend = backendWith(() => {
    const client = new HelperClient({
      binaryPath: process.execPath,
      args: ["-e", FAKE_HELPER_SOURCE],
    });
    clients.push(client);
    return client;
  });
  const inputLog = async (): Promise<readonly string[]> => {
    expect(clients).toHaveLength(1);
    const result = (await clients[0]!.request("log")) as { readonly log: readonly string[] };
    return result.log;
  };
  return { backend, inputLog };
}

describe("stale descriptor detection", () => {
  it("recognizes the helper's dead-framebuffer failures", () => {
    expect(isStaleDescriptorError(new Error("display has no framebuffer surface yet"))).toBe(true);
    expect(isStaleDescriptorError(new Error("not attached to a simulator"))).toBe(true);
  });

  it("does not treat unrelated failures as stale descriptors", () => {
    // A genuine refusal must surface, not trigger a silent re-attach loop.
    expect(isStaleDescriptorError(new Error("simulator is not booted"))).toBe(false);
    expect(isStaleDescriptorError(new Error("unknown method 'tap'"))).toBe(false);
  });
});

describe("simulator reboot", () => {
  it("re-attaches after a Ryco-driven shutdown and reboot", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);

    await backend.shutdown(DEVICE);
    helper.bootGeneration = 2;
    await backend.tap(DEVICE, 20, 20);

    // The shutdown dropped the cached attachment, so this is a clean re-attach
    // rather than a forced retry.
    expect(helper.attachCalls).toEqual([
      { udid: DEVICE, force: false },
      { udid: DEVICE, force: false },
    ]);
  });

  it("recovers when the device was rebooted outside Ryco", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);

    // No shutdown call to observe: Simulator.app or the agent's own shell did
    // it, so the only signal is the failure itself.
    helper.bootGeneration = 2;
    await backend.tap(DEVICE, 20, 20);

    expect(helper.attachCalls.at(-1)).toEqual({ udid: DEVICE, force: true });
  });

  it("survives repeated boot, attach, shutdown cycles", async () => {
    const { backend, helper } = makeBackend();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      helper.bootGeneration = cycle;
      await backend.tap(DEVICE, 5, 5);
      await backend.shutdown(DEVICE);
    }

    // Every cycle worked; none fell into the permanent-failure state.
    expect(helper.attachCalls).toHaveLength(3);
    expect(helper.attachCalls.every((call) => !call.force)).toBe(true);
  });

  it("surfaces a non-descriptor failure instead of retrying it", async () => {
    const { backend, helper } = makeBackend();
    helper.attach = async () => {
      throw new Error("simulator is not booted");
    };

    await expect(backend.tap(DEVICE, 1, 1)).rejects.toThrow("not booted");
  });
});

describe("undelivered input recovery", () => {
  // Which errors are retried, and how, is tested rule by rule in
  // helperInputErrors.test.ts; these check that the backend acts on it.
  it("rebinds the HID client and retries once when nothing was sent", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);
    helper.attachCalls.length = 0;
    helper.requestCalls.length = 0;

    // A stale HID client accepts the call but the event never lands. Before the
    // fix the helper acked this as success and the tap silently vanished.
    helper.undeliverableCalls = 1;
    await backend.tap(DEVICE, 20, 20);

    // The recovery path re-asserts the attachment and then forces a rebind, so
    // the retry lands on a freshly built HID client.
    expect(helper.attachCalls.some((call) => call.force)).toBe(true);
    expect(helper.requestCalls).toEqual(["tap", "tap"]);
  });

  it("surfaces the failure when the retry also fails to deliver", async () => {
    const { backend, helper } = makeBackend();
    helper.undeliverableCalls = 5;

    await expect(backend.tap(DEVICE, 1, 1)).rejects.toThrow("not delivered");
    expect(helper.requestCalls).toEqual(["tap", "tap"]);
  });

  it("never replays an operation that may have been partially delivered", async () => {
    const { backend, helper } = makeBackend();
    // Its detail mentions "nothing was sent", but only as the cause of the
    // event that failed after earlier ones went out.
    const failure = undelivered(
      "input may have been partially delivered; do not replay: the simulator's input service (dtuhidd) is still starting; delivery unknown",
    );
    helper.failures = [failure];

    await expect(backend.typeText(DEVICE, "hello")).rejects.toThrow(failure);
    // Typed once: a replay would enter the delivered prefix a second time.
    expect(helper.requests.filter((request) => request.method === "text")).toHaveLength(1);
    expect(helper.attachCalls.some((call) => call.force)).toBe(false);
  });

  it("retries once on the same attachment while dtuhidd is still starting", async () => {
    const { backend, helper } = makeBackend();
    helper.failures = [
      undelivered(
        "nothing was sent: the simulator's input service (dtuhidd) is still starting; nothing was sent",
      ),
    ];

    await backend.tap(DEVICE, 10, 10);

    // A forced re-attach would build a new transport and restart the warm-up.
    expect(helper.requestCalls).toEqual(["tap", "tap"]);
    expect(helper.attachCalls.some((call) => call.force)).toBe(false);
  });

  it("does not retry a second time while dtuhidd is still starting", async () => {
    const { backend, helper } = makeBackend();
    const starting = undelivered(
      "nothing was sent: the simulator's input service (dtuhidd) is still starting; nothing was sent",
    );
    helper.failures = [starting, starting];

    await expect(backend.tap(DEVICE, 10, 10)).rejects.toThrow("still starting");
    expect(helper.requestCalls).toEqual(["tap", "tap"]);
    expect(helper.attachCalls.some((call) => call.force)).toBe(false);
  });

  it("retries a dtuhidd failure on the same attachment instead of re-attaching", async () => {
    const { backend, helper } = makeBackend();
    helper.inputTransport = "dtuhid";
    const missing = undelivered(
      "nothing was sent: the simulator does not vend com.apple.coredevice.feature.remote.hid.digitizer yet (lookup failed)",
    );
    helper.failures = [missing, missing];

    await expect(backend.tap(DEVICE, 10, 10)).rejects.toThrow("does not vend");
    // dtuhidd reconnects by itself; a re-attach would build a new transport
    // and restart its whole warm-up before the retry could run.
    expect(helper.requestCalls).toEqual(["tap", "tap"]);
    expect(helper.attachCalls.some((call) => call.force)).toBe(false);
  });

  it("does not retry an operation refused for the input deadline", async () => {
    const { backend, helper } = makeBackend();
    const failure = undelivered(
      "nothing was sent: long press cannot finish inside the input deadline",
    );
    helper.failures = [failure];

    await expect(backend.tap(DEVICE, 10, 10)).rejects.toThrow(failure);
    expect(helper.requestCalls).toEqual(["tap"]);
    expect(helper.attachCalls.some((call) => call.force)).toBe(false);
  });
});

describe("text entry", () => {
  const typedChunks = (helper: FakeHelper): string[] =>
    helper.requests
      .filter((request) => request.method === "text")
      .map((request) => String(request.params.text));

  it("sends long text in chunks of at most 120 characters, in order", async () => {
    const { backend, helper } = makeBackend();
    const text = Array.from({ length: 250 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");

    await backend.typeText(DEVICE, text);

    const chunks = typedChunks(helper);
    // One 250-character RPC would outlast the helper's 13 s input budget.
    expect(chunks.map((chunk) => chunk.length)).toEqual([120, 120, 10]);
    expect(chunks.join("")).toBe(text);
  });

  it("stops at the chunk that failed and sends nothing after it", async () => {
    const { backend, helper } = makeBackend();
    const failure = undelivered(
      "input may have been partially delivered; do not replay: dtuhidd did not take the events in time",
    );
    // The first chunk lands, the second fails part-way.
    helper.failures = [null, failure];

    const error = await backend.typeText(DEVICE, "x".repeat(300)).then(
      () => null,
      (cause: unknown) => cause as Error,
    );
    expect(error?.message).toContain(failure);
    // Part of the failing chunk may have landed: no exact count to retype from.
    expect(error?.message).toMatch(
      /^Typed at least the first 120 \(at most 240\) of 300 characters/,
    );
    expect(typedChunks(helper).map((chunk) => chunk.length)).toEqual([120, 120]);
  });

  it('does not let a later chunk\'s "nothing was sent" invite a replay of the whole text', async () => {
    const { backend, helper } = makeBackend();
    const starting = undelivered(
      "nothing was sent: the simulator's input service (dtuhidd) is still starting; nothing was sent",
    );
    // The first chunk lands; the second fails, and so does its retry.
    helper.failures = [null, starting, starting];

    const error = await backend.typeText(DEVICE, "x".repeat(300)).then(
      () => null,
      (cause: unknown) => cause as Error,
    );

    expect(error?.message).toMatch(/^Typed the first 120 of 300 characters/);
    expect(error?.message).toMatch(/partially delivered; do not replay it whole/);
    // Read on its own, "nothing was sent" says the call is safe to repeat,
    // and repeating it would type the first 120 characters twice.
    expect(error?.message).not.toMatch(/nothing was sent/i);
    expect(error?.message).toMatch(/still starting/);
    expect(typedChunks(helper).map((chunk) => chunk.length)).toEqual([120, 120, 120]);
  });

  it("passes a first-chunk failure on unchanged: nothing of the text was typed", async () => {
    const { backend, helper } = makeBackend();
    const starting = undelivered(
      "nothing was sent: the simulator's input service (dtuhidd) is still starting; nothing was sent",
    );
    helper.failures = [starting, starting];

    await expect(backend.typeText(DEVICE, "x".repeat(300))).rejects.toThrow(starting);
    expect(typedChunks(helper)).toHaveLength(2);
  });

  it("keeps other input to the device out until every chunk is typed", async () => {
    const { backend, helper } = makeBackend();
    helper.requestDelayMs = 5;

    const typing = backend.typeText(DEVICE, "y".repeat(250));
    // A pane tap while the agent types: it must not land between chunks,
    // where it could move focus and send the rest of the text elsewhere.
    const tapping = backend.tap(DEVICE, 10, 10);
    await Promise.all([typing, tapping]);

    expect(helper.requestCalls).toEqual(["text", "text", "text", "tap"]);
  });

  it("keeps a key chord together and lets a failed call release the queue", async () => {
    const { backend, helper } = makeBackend();
    helper.requestDelayMs = 5;
    helper.failures = ["simulator is not booted"];

    const failing = backend.tap(DEVICE, 1, 1);
    const chord = backend.keyEvent(DEVICE, {
      keyCode: 4,
      direction: "down",
      modifiers: ["shift", "command"],
    });
    const after = backend.tap(DEVICE, 2, 2);
    await expect(failing).rejects.toThrow("not booted");
    await Promise.all([chord, after]);

    expect(helper.requestCalls).toEqual(["tap", "key", "key", "key", "tap"]);
  });

  it("still sends empty text to the helper, which refuses it as before", async () => {
    const { backend, helper } = makeBackend();

    await backend.typeText(DEVICE, "");

    expect(typedChunks(helper)).toEqual([""]);
  });

  it("never splits a surrogate pair between chunks", () => {
    const emoji = "\u{1F600}";
    // 119 letters, then an emoji whose two code units straddle the 120 cut.
    const text = `${"a".repeat(119)}${emoji}b`;

    const chunks = textChunks(text, 120);

    expect(chunks).toEqual(["a".repeat(119), `${emoji}b`]);
    expect(chunks.join("")).toBe(text);
    expect(textChunks("", 120)).toEqual([""]);
    expect(textChunks("abc", 2)).toEqual(["ab", "c"]);
  });
});

describe("input to several simulators", () => {
  const OTHER = "BBBB-2222";
  const THIRD = "CCCC-3333";

  it("keeps a tap on another device out of a chunked text until it is typed", async () => {
    const { backend, inputLog } = makeBackendWithHelperProcess();
    try {
      await backend.tap(DEVICE, 1, 1);
      const typing = backend.typeText(DEVICE, "a".repeat(250));
      const tapping = backend.tap(OTHER, 1, 1);
      await Promise.all([typing, tapping]);

      expect(await inputLog()).toEqual([
        "tap->AAAA-1111",
        ...Array(3).fill("text->AAAA-1111"),
        "tap->BBBB-2222",
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it("never types one device's text into another attached at the same time", async () => {
    const { backend, inputLog } = makeBackendWithHelperProcess();
    try {
      await backend.tap(THIRD, 1, 1);
      await Promise.all([backend.typeText(DEVICE, "secret"), backend.tap(OTHER, 1, 1)]);

      expect(await inputLog()).toEqual(["tap->CCCC-3333", "text->AAAA-1111", "tap->BBBB-2222"]);
    } finally {
      await backend.dispose();
    }
  });

  it("sends each device's tap to it while a text call is in flight", async () => {
    const { backend, inputLog } = makeBackendWithHelperProcess();
    try {
      await backend.tap(DEVICE, 1, 1);
      const typing = backend.typeText(DEVICE, "b".repeat(100));
      const tappingOther = backend.tap(OTHER, 1, 1);
      const tappingAgain = backend.tap(DEVICE, 1, 1);
      await Promise.all([typing, tappingOther, tappingAgain]);

      expect(await inputLog()).toEqual([
        "tap->AAAA-1111",
        "text->AAAA-1111",
        "tap->BBBB-2222",
        "tap->AAAA-1111",
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it("starts one helper for first calls to two devices", async () => {
    const { backend, inputLog } = makeBackendWithHelperProcess();
    try {
      await Promise.all([backend.typeText(DEVICE, "secret"), backend.tap(OTHER, 1, 1)]);

      expect(await inputLog()).toEqual(["text->AAAA-1111", "tap->BBBB-2222"]);
    } finally {
      await backend.dispose();
    }
  });
});

describe("input transport logging", () => {
  it("names the transport once per backend, not on every attach", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { backend, helper } = makeBackend();
      helper.inputTransport = "dtuhid";
      await backend.tap(DEVICE, 10, 10);
      await backend.shutdown(DEVICE);
      await backend.tap(DEVICE, 10, 10);

      const transportLines = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("input goes through"));
      expect(helper.attachCalls).toHaveLength(2);
      expect(transportLines).toEqual([
        "[device] iOS Simulator input goes through dtuhid on this Xcode",
      ]);
    } finally {
      info.mockRestore();
    }
  });
});
