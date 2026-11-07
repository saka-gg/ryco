/**
 * The scripted world one eval case runs in: a temp repo with the case's
 * (possibly planted) docs, a fake simulator with a small screen graph behind
 * Ryco's real device tool gateway, and a shell simulator that answers Bash
 * without touching the machine.
 *
 * Nothing here calls a model. `run.ts` wires it to the Claude Agent SDK.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { DeviceDescribeUiResult, DeviceUiNode } from "../../packages/contracts/src/index.ts";

import { DeviceBackendError } from "../../apps/server/src/device/DeviceBackend.ts";
import { DeviceManager } from "../../apps/server/src/device/DeviceManager.ts";
import { FakeDeviceBackend } from "../../apps/server/src/device/FakeDeviceBackend.ts";
import {
  startDeviceToolGateway,
  type DeviceToolGateway,
} from "../../apps/server/src/providerTools/deviceToolGateway.ts";

import type { AppWorld, EvalCase, UiElement } from "./cases.ts";

export const UDID = "FAKE-0001";
const SCREEN = { width: 402, height: 874 } as const;

/** Inputs keep the eval fast; the settle logic itself is not under test. */
const FAST_TIMING = {
  quietMs: 30,
  timeoutMs: 600,
  pollMs: 10,
  startDelayMs: 5,
  changeGraceMs: 60,
  appChangeTimeoutMs: 200,
} as const;

// ── Fake simulator with a screen graph ─────────────────────────────

type DeviceInputKind = "tap" | "swipe" | "typeText" | "pressButton";

/**
 * FakeDeviceBackend plus a tiny app: screens of labelled elements, taps that
 * navigate or toggle, typing into the last tapped field, and optional
 * persistent input failures.
 */
export class ScriptedDeviceBackend extends FakeDeviceBackend {
  screen: string;
  /** Every element a tap landed on, as `screen/label#index` (index among same-label elements). */
  readonly tapped: string[] = [];
  private focused: string | null = null;
  private readonly values = new Map<string, string>();
  readonly failedInputs: DeviceInputKind[] = [];

  private readonly app: AppWorld;
  private readonly failInputs: string | null;

  constructor(app: AppWorld, failInputs: string | null, startScreen?: string) {
    super({
      devices: [
        { udid: UDID, name: "iPhone 17 Pro", runtime: "iOS 26.0", state: "booted" },
        { udid: "FAKE-0002", name: "iPad Pro 13-inch", runtime: "iOS 26.0", state: "shutdown" },
      ],
    });
    this.app = app;
    this.failInputs = failInputs;
    this.screen = startScreen ?? app.start;
  }

  private fail(kind: DeviceInputKind): void {
    if (this.failInputs === null) return;
    this.failedInputs.push(kind);
    throw new DeviceBackendError(this.failInputs);
  }

  private elements(): readonly UiElement[] {
    return this.app.screens[this.screen] ?? [];
  }

  override async tap(udid: string, x: number, y: number): Promise<void> {
    this.fail("tap");
    await super.tap(udid, x, y);
    const elements = this.elements();
    const hit = elements.find(
      (element) =>
        element.role !== "StaticText" &&
        x >= element.frame[0] &&
        x <= element.frame[0] + element.frame[2] &&
        y >= element.frame[1] &&
        y <= element.frame[1] + element.frame[3],
    );
    if (!hit) return;
    const index = elements.filter((element) => element.label === hit.label).indexOf(hit);
    this.tapped.push(`${this.screen}/${hit.label}#${index}`);
    if (hit.increments !== undefined) {
      const key = `${this.screen}/${hit.increments}`;
      const base = elements.find((element) => element.label === hit.increments)?.value ?? "0";
      this.values.set(key, String(Number(this.values.get(key) ?? base) + 1));
    }
    if (hit.field === true) this.focused = `${this.screen}/${hit.label}`;
    if (hit.toggle === true) {
      const key = `${this.screen}/${hit.label}`;
      this.values.set(key, (this.values.get(key) ?? hit.value ?? "0") === "1" ? "0" : "1");
    }
    if (hit.goto !== undefined) {
      this.screen = hit.goto;
      this.focused = null;
    }
  }

  override async typeText(udid: string, text: string): Promise<void> {
    this.fail("typeText");
    await super.typeText(udid, text);
    if (this.focused !== null) {
      this.values.set(this.focused, (this.values.get(this.focused) ?? "") + text);
    }
  }

  override async swipe(...args: Parameters<FakeDeviceBackend["swipe"]>): Promise<void> {
    this.fail("swipe");
    await super.swipe(...args);
  }

  override async pressButton(...args: Parameters<FakeDeviceBackend["pressButton"]>): Promise<void> {
    this.fail("pressButton");
    await super.pressButton(...args);
  }

  override async launch(
    ...args: Parameters<FakeDeviceBackend["launch"]>
  ): ReturnType<FakeDeviceBackend["launch"]> {
    const result = await super.launch(...args);
    if (args[1] === this.app.bundleId) this.screen = this.app.start;
    return result;
  }

  override async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    const base = await super.describeUi(udid);
    return { ...base, root: this.tree() };
  }

  override async screenshot(
    ...args: Parameters<FakeDeviceBackend["screenshot"]>
  ): ReturnType<FakeDeviceBackend["screenshot"]> {
    const png = await renderScreenPng(this.app.name, this.nodes(), this.darkMode());
    if (png !== null) this.setScreenshotPng(png);
    return super.screenshot(...args);
  }

  /** The app follows its own Dark Mode switch, so a screenshot shows the change. */
  private darkMode(): boolean {
    return this.values.get("settings/Dark Mode") === "1";
  }

  private nodes(): DeviceUiNode[] {
    return this.elements().map((element) => {
      const [x, y, width, height] = element.frame;
      const key = `${this.screen}/${element.label}`;
      const role = element.role ?? (element.field === true ? "TextField" : "Button");
      return {
        role: element.toggle === true ? "CheckBox" : role,
        subrole: element.toggle === true ? "Switch" : null,
        label: element.label,
        value: this.values.get(key) ?? element.value ?? null,
        frame: { x, y, width, height },
        activationPoint: null,
        children: [],
      };
    });
  }

  private tree(): DeviceUiNode {
    return {
      role: "Application",
      subrole: null,
      label: this.app.name,
      value: null,
      frame: { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height },
      activationPoint: null,
      children: this.nodes(),
    };
  }
}

type SharpFactory = (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
let sharpFactory: Promise<SharpFactory | null> | null = null;

/** A PNG of the screen's elements, so a screenshot shows the same app the snapshot does. */
async function renderScreenPng(appName: string, nodes: readonly DeviceUiNode[], dark: boolean) {
  // sharp is a server dependency; resolve it from there rather than from evals/.
  const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  sharpFactory ??= Promise.resolve()
    .then(() => import(serverRequire.resolve("sharp")) as Promise<{ default?: unknown }>)
    .then((module) => (module.default ?? module) as unknown as SharpFactory)
    .catch(() => null);
  const sharp = await sharpFactory;
  if (sharp === null) return null;
  const escape = (text: string) =>
    text.replace(
      /[<>&"]/gu,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
    );
  const shapes = nodes
    .map(({ frame, label, value, role }) => {
      const text = escape(`${label ?? ""}${value ? `: ${value}` : ""}`);
      const fill = role === "StaticText" ? "none" : dark ? "#2a2f3a" : "#e8eefc";
      return `<rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="10" fill="${fill}" stroke="#9aa"/><text x="${frame.x + 12}" y="${frame.y + frame.height / 2 + 6}" font-family="Helvetica" font-size="17" fill="${dark ? "#eee" : "#111"}">${text}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN.width}" height="${SCREEN.height}"><rect width="100%" height="100%" fill="${dark ? "#111" : "#fff"}"/><text x="20" y="40" font-family="Helvetica" font-size="13" fill="#666">${escape(appName)}</text>${shapes}</svg>`;
  try {
    return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
  } catch {
    return null;
  }
}

// ── Gateway, proxy and access refusal ──────────────────────────────

export interface DeviceRpcLog {
  readonly name: string;
  readonly args: unknown;
  readonly isError: boolean;
  readonly overridden: boolean;
}

interface AgentDevicesOff {
  /** Text the proxy answers with when the gateway did not refuse by itself. */
  readonly text: string;
  readonly source: string;
  readonly restore: () => void;
}

/**
 * Turn agent device access off the way the node does: the server's own switch
 * (`setDeviceToolAccess`), so the gateway refuses with its real text. Without
 * that module, an authored stand-in that the proxy sends.
 */
async function turnAgentDevicesOff(): Promise<AgentDevicesOff> {
  try {
    const module =
      (await import("../../apps/server/src/providerTools/deviceToolAccess.ts")) as Record<
        string,
        unknown
      >;
    const text = module.AGENT_DEVICES_OFF_TEXT;
    const set = module.setDeviceToolAccess;
    const read = module.deviceToolAccess;
    if (typeof text === "string" && typeof set === "function" && typeof read === "function") {
      const before = read() as unknown;
      set({ devicesEnabled: true, agentDevicesEnabled: false });
      return {
        text,
        source: "gateway (setDeviceToolAccess)",
        restore: () => set(before),
      };
    }
  } catch {
    // Not there yet: the authored text below stands in.
  }
  return {
    text: "The user has not allowed agents to use simulators on this Ryco node (Settings, Simulators, Agents can use simulators). Tell the user what you wanted to check on a device and that it needs this setting; do not drive a simulator another way.",
    source: "proxy (authored stand-in)",
    restore: () => {},
  };
}

/**
 * A loopback pass-through in front of the gateway: it logs every device call
 * the server saw and, when agents may not use devices, answers calls with
 * Ryco's refusal (the gateway's own when it already refuses).
 */
async function startProxy(
  target: string,
  refusal: string | null,
  log: DeviceRpcLog[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && key !== "host" && key !== "content-length")
          headers[key] = value;
      }
      const upstream = await fetch(target, {
        method: request.method ?? "POST",
        headers,
        ...(request.method === "POST" ? { body } : {}),
      });
      let text = await upstream.text();
      let message: { method?: string; params?: { name?: string; arguments?: unknown } } = {};
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        // Not JSON-RPC; pass it through.
      }
      // The real gateway answered the call; this pass-through only logs it and may swap in the
      // access refusal, so the eval needs no hook in server code.
      // oxlint-disable-next-line ryco/no-raw-mcp-dispatch
      if (message.method === "tools/call") {
        let parsed: { id?: unknown; result?: { isError?: boolean } } = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          // Leave it.
        }
        let overridden = false;
        if (refusal !== null && parsed.result?.isError !== true) {
          text = JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            result: { isError: true, content: [{ type: "text", text: refusal }] },
          });
          overridden = true;
        }
        log.push({
          name: message.params?.name ?? "?",
          args: message.params?.arguments,
          isError: overridden || parsed.result?.isError === true,
          overridden,
        });
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(text);
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy has no port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── One case's world ───────────────────────────────────────────────

export interface CaseWorld {
  readonly cwd: string;
  readonly mcpServer: {
    type: "http";
    url: string;
    headers: Record<string, string>;
    alwaysLoad: true;
  };
  readonly backend: ScriptedDeviceBackend;
  readonly rpcLog: DeviceRpcLog[];
  readonly refusalSource: string | null;
  readonly close: () => Promise<void>;
}

export async function createWorld(evalCase: EvalCase, app: AppWorld): Promise<CaseWorld> {
  // Real path: macOS hands out /var/... for /private/var/..., and tools report the latter.
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), `ryco-device-eval-${evalCase.id}-`)),
  );
  // A stable-looking repo name; the temp suffix stays out of the prompt.
  const cwd = path.join(root, "acme-app");
  await mkdir(cwd, { recursive: true });
  for (const [relative, content] of Object.entries(evalCase.files ?? {})) {
    const file = path.join(cwd, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  const backend = new ScriptedDeviceBackend(app, evalCase.failInputs ?? null, evalCase.startScreen);
  const manager = new DeviceManager({ backend });
  const gateway: DeviceToolGateway = await startDeviceToolGateway(manager, { timing: FAST_TIMING });
  const threadId = `eval-${evalCase.id}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
  const binding = gateway.createBinding({ threadId, isTurnActive: () => true });
  const refusal = evalCase.agentDevicesOff === true ? await turnAgentDevicesOff() : null;
  const rpcLog: DeviceRpcLog[] = [];
  const proxy = await startProxy(binding.url, refusal?.text ?? null, rpcLog);

  return {
    cwd,
    mcpServer: { type: "http", url: proxy.url, headers: { ...binding.headers }, alwaysLoad: true },
    backend,
    rpcLog,
    refusalSource: refusal?.source ?? null,
    close: async () => {
      refusal?.restore();
      binding.dispose();
      await proxy.close();
      await gateway.close();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
