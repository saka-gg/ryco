import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { app, dialog, shell, systemPreferences, type BrowserWindow } from "electron";
import {
  ComputerUsePolicy,
  ComputerUseRequest,
  type ComputerBrowser,
  type ComputerUseActivity,
  type ComputerUseApp,
  type ComputerUseBridgeConfig,
  type ComputerUsePairing,
  type ComputerUseState,
} from "@ryco/contracts";
import { Schema } from "effect";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "./policy.ts";
import { ComputerNativeHelper } from "./helper.ts";
import { ComputerPermissionMonitor } from "./permissions.ts";
import { NativeComputerDriver, record } from "./native.ts";
import { BrowserComputerDriver, type BrowserTransport } from "./browser.ts";
import { EmbeddedComputerBrowser } from "./embeddedBrowser.ts";
import { ExternalComputerBrowser } from "./externalBrowser.ts";
import { ComputerUseOverlay } from "./overlay.ts";
import { openBrowserExtensions } from "./browserSetup.ts";

const BROWSER_NAMES = {
  ryco: "Ryco Browser",
  chrome: "Google Chrome",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
} as const;
function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class DesktopComputerUseRuntime {
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });
  private readonly transports = new Map<ComputerBrowser, BrowserTransport>();
  private readonly embedded = new EmbeddedComputerBrowser();
  private readonly browser = new BrowserComputerDriver(this.transports);
  private readonly native: NativeComputerDriver;
  private readonly overlay: ComputerUseOverlay;
  private readonly policyController: ComputerPolicyController;
  private token = randomBytes(32).toString("base64url");
  private readonly pairings = new Map<ComputerBrowser, string>();
  private port = 0;
  private activity: ComputerUseActivity | null = null;
  private apps: ComputerUseApp[] = [];
  private readonly permissions: ComputerPermissionMonitor;
  private readonly permissionAppName: string;
  private error: string | null = null;
  private closed = false;

  private readonly options: {
    stateDir: string;
    helperPath: string;
    extensionPath: string;
    getWindow(): BrowserWindow | null;
    changed(state: ComputerUseState): void;
  };
  constructor(options: {
    stateDir: string;
    helperPath: string;
    extensionPath: string;
    getWindow(): BrowserWindow | null;
    changed(state: ComputerUseState): void;
  }) {
    this.options = options;
    const policyPath = join(options.stateDir, "computer-use-policy.json");
    let policy = DEFAULT_COMPUTER_POLICY;
    try {
      policy = Schema.decodeUnknownSync(ComputerUsePolicy)(
        JSON.parse(readFileSync(policyPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = "Saved computer-use settings could not be read. Access is disabled.";
    }
    const exe = app.getPath("exe");
    const marker = exe.indexOf(".app/");
    this.native = new NativeComputerDriver(
      new ComputerNativeHelper(options.helperPath, join(options.stateDir, "computer-use-native")),
      marker >= 0 ? exe.slice(0, marker + 4) : exe,
    );
    this.permissions = new ComputerPermissionMonitor(() => this.native.helper.probePermissions());
    this.permissionAppName =
      marker >= 0 ? basename(exe.slice(0, marker + 4), ".app") : app.getName();
    this.transports.set("ryco", this.embedded);
    this.overlay = new ComputerUseOverlay(
      () => this.stop(),
      () => {
        this.activity = null;
        this.publish();
      },
    );
    this.policyController = new ComputerPolicyController({
      policy,
      persist: (next) => {
        mkdirSync(dirname(policyPath), { recursive: true });
        const temporary = `${policyPath}.${randomBytes(8).toString("hex")}.tmp`;
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        renameSync(temporary, policyPath);
        queueMicrotask(() => this.publish());
      },
      activity: (activity) => {
        this.activity = activity;
        const updated = this.overlay.show(activity);
        this.publish();
        return updated;
      },
      cancel: () => {
        this.native.stop();
        this.browser.stop();
      },
      consent: async ({ appId, name, foreground, threadId, signal }) => {
        const owner = options.getWindow();
        if (!owner || owner.isDestroyed()) return "block";
        const response = await dialog.showMessageBox(owner, {
          signal,
          type: "question",
          title: foreground ? "Allow foreground takeover?" : "Allow Ryco to use this app?",
          message: foreground
            ? "Ryco will use your mouse and keyboard."
            : `Allow Ryco to see and control ${name}?`,
          detail: `${foreground ? "This takes over the active desktop." : `Application: ${appId}`}\nThread: ${threadId}\nUse ${process.platform === "darwin" ? "⌘" : "Ctrl"}+Shift+Escape to stop.`,
          buttons: foreground
            ? ["Cancel", "Allow for this turn"]
            : ["Block app", "Allow for this turn", "Always allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return response.response === 2 ? "allow" : response.response === 1 ? "once" : "block";
      },
    });
    this.overlay.setEnabled(policy.enabled);
    this.server = createServer((request, response) => {
      void (async () => {
        response.setHeader("cache-control", "no-store");
        if (
          request.method !== "POST" ||
          request.url !== "/control" ||
          request.headers.origin !== undefined ||
          !equalSecret(request.headers.authorization ?? "", `Bearer ${this.token}`)
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        const authorizedToken = this.token;
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const raw of request) {
          const chunk = Buffer.from(raw);
          size += chunk.length;
          if (size > 256 * 1024) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(chunk);
        }
        if (authorizedToken !== this.token || this.closed || response.destroyed) {
          response.writeHead(403);
          response.end();
          return;
        }
        const input = Schema.decodeUnknownSync(ComputerUseRequest)(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const controller = new AbortController();
        const disconnected = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.on("close", disconnected);
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
          const value = await this.policyController.execute(
            input,
            controller.signal,
            async (context) => {
              if (input.tool === "computer") return this.native.execute(context);
              const browser = input.args.browser as ComputerBrowser;
              if (
                !Object.hasOwn(BROWSER_NAMES, browser) ||
                !this.policyController.policy.browsers.includes(browser)
              )
                throw new Error("This browser is disabled in Computer use settings.");
              const browserApp = this.apps.find(
                (candidate) =>
                  candidate.name.toLowerCase() === BROWSER_NAMES[browser].toLowerCase(),
              );
              if (browserApp) await context.authorizeApp(browserApp.id, browserApp.name);
              await context.authorizeApp(`browser:${browser}`, BROWSER_NAMES[browser]);
              return this.browser.execute(context, browser);
            },
          );
          if (!controller.signal.aborted) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(value));
          }
        } catch (error) {
          if (!response.headersSent)
            response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    error instanceof Error ? error.message.slice(0, 512) : "Computer use failed.",
                },
              ],
            }),
          );
        } finally {
          clearTimeout(timer);
          response.off("close", disconnected);
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.on("upgrade", (request, socket, head) => {
      if (
        request.url !== "/browser" ||
        this.closed ||
        !this.policyController.policy.enabled ||
        !/^chrome-extension:\/\/[a-p]{32}$/u.test(request.headers.origin ?? "")
      ) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (connection) => {
        // Invalid frames can arrive before authentication installs the transport.
        // An unhandled WebSocket error would otherwise terminate the desktop app.
        connection.on("error", () => connection.terminate());
        const timer = setTimeout(() => connection.close(), 5_000);
        connection.once("message", (bytes) => {
          clearTimeout(timer);
          try {
            const auth = record(JSON.parse(bytes.toString()));
            const browser = auth.browser as ComputerBrowser;
            const expected = this.pairings.get(browser);
            if (
              !expected ||
              !this.policyController.policy.enabled ||
              !this.policyController.policy.browsers.includes(browser) ||
              typeof auth.token !== "string" ||
              !equalSecret(auth.token, expected)
            ) {
              connection.close();
              return;
            }
            this.transports.get(browser)?.stop();
            const transport = new ExternalComputerBrowser(connection, () => {
              if (this.transports.get(browser) === transport) this.transports.delete(browser);
              this.publish();
            });
            this.transports.set(browser, transport);
            connection.send(JSON.stringify({ type: "authenticated" }));
            this.publish();
          } catch {
            connection.close();
          }
        });
        connection.once("close", () => clearTimeout(timer));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string")
          return reject(new Error("Computer-use bridge did not start."));
        this.port = address.port;
        resolve();
      });
    });
  }
  backendBinding(): ComputerUseBridgeConfig {
    this.stop();
    this.token = randomBytes(32).toString("base64url");
    return { url: `http://127.0.0.1:${this.port}/control`, token: this.token };
  }
  state(): ComputerUseState {
    const permissions = this.permissions.state();
    return {
      policy: this.policyController.policy,
      apps: this.apps,
      connectedBrowsers: [...this.transports.keys()].filter((browser) => browser !== "ryco"),
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
      helperAvailable: permissions.helperAvailable,
      permissionInfo: {
        checkedAt: permissions.checkedAt,
        error: permissions.error,
        appName: this.permissionAppName,
        development: !app.isPackaged,
      },
      activity: this.activity,
      error: this.error,
    };
  }
  private publish(): void {
    if (!this.closed) this.options.changed(this.state());
  }
  update(raw: unknown): ComputerUseState {
    this.policyController.update(Schema.decodeUnknownSync(ComputerUsePolicy)(raw));
    if (!this.overlay.setEnabled(this.policyController.policy.enabled))
      this.error =
        "The emergency shortcut is in use by another app. Use Stop all in Ryco settings.";
    this.publish();
    return this.state();
  }
  async refreshPermissions(): Promise<ComputerUseState> {
    await this.permissions.refresh();
    this.publish();
    return this.state();
  }
  async refresh(query?: string): Promise<ComputerUseState> {
    await this.refreshPermissions();
    if (!this.permissions.state().helperAvailable) return this.state();
    try {
      const found = await this.native.listApps(query);
      const entries = new Map(this.apps.map((entry) => [entry.id, entry]));
      for (const entry of found) entries.set(entry.id, entry);
      this.apps = [...entries.values()]
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .slice(0, 1000);
      this.error = null;
    } catch {
      this.error = "App discovery failed. Permission status is shown separately; retry Find apps.";
    }
    this.publish();
    return this.state();
  }
  async permission(kind: "accessibility" | "screenRecording"): Promise<void> {
    if (process.platform !== "darwin") return;
    if (kind === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal(
      kind === "accessibility"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  pair(browser: ComputerBrowser): ComputerUsePairing {
    if (
      browser === "ryco" ||
      !Object.hasOwn(BROWSER_NAMES, browser) ||
      !this.policyController.policy.enabled ||
      !this.policyController.policy.browsers.includes(browser)
    )
      throw new Error("Enable this browser before pairing.");
    this.transports.get(browser)?.stop();
    const token = randomBytes(32).toString("base64url");
    this.pairings.set(browser, token);
    return { browser, url: `ws://127.0.0.1:${this.port}/browser`, token };
  }
  showExtension(): string {
    shell.showItemInFolder(join(this.options.extensionPath, "manifest.json"));
    return this.options.extensionPath;
  }
  async openBrowserSetup(browser: ComputerBrowser): Promise<void> {
    await openBrowserExtensions(browser);
  }
  stop(): void {
    this.policyController.stop();
    this.publish();
  }
  dispose(): void {
    this.closed = true;
    this.stop();
    this.overlay.dispose();
    this.embedded.dispose();
    this.sockets.close();
    this.server.closeAllConnections();
    this.server.close();
  }
}
