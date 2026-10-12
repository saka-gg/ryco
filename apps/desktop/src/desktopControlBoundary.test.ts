import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

describe("Desktop-main local control credential boundary", () => {
  it("passes a fresh per-child credential only through the inherited bootstrap pipe", () => {
    const main = source("main.ts");
    const launcher = source("backendLauncher.ts");
    const start = main.indexOf("function startBackend(): void");
    const stop = main.indexOf("async function stopBackendAndWaitForExit(", start);
    const startBackend = main.slice(start, stop);
    const envelopeStart = main.indexOf("function writeBackendBootstrapEnvelope(");
    const envelope = main.slice(envelopeStart, main.indexOf("\n}\n", envelopeStart));

    expect(startBackend).toContain('Crypto.randomBytes(32).toString("base64url")');
    expect(startBackend).toContain("controlToken: childControlToken");
    expect(startBackend).not.toContain("process.env.desktopControlToken");
    expect(envelope).toContain("desktopControlToken: input.controlToken");
    expect(envelope).toContain("const bootstrapStream = child.stdio[DESKTOP_BACKEND_BOOTSTRAP_FD]");
    expect(envelope).toContain("desktopTelemetryFd: DESKTOP_BACKEND_TELEMETRY_FD");
    // The launcher owns the pipes and never sees the credential.
    expect(launcher).toContain('["ignore", "pipe", "pipe", "pipe", "pipe"]');
    expect(launcher).toContain("export const DESKTOP_BACKEND_BOOTSTRAP_FD = 3;");
    expect(launcher).toContain("export const DESKTOP_BACKEND_TELEMETRY_FD = 4;");
    expect(launcher).not.toContain("ControlToken");
  });

  it("never exposes the credential through preload or renderer bootstrap IPC", () => {
    const main = source("main.ts");
    const preload = source("preload.ts");
    const handlerStart = main.indexOf(
      "ipcMain.on(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL, (event) =>",
    );
    const handlerEnd = main.indexOf(
      "ipcMain.removeHandler(GET_CLIENT_SETTINGS_CHANNEL)",
      handlerStart,
    );
    const rendererBootstrapHandler = main.slice(handlerStart, handlerEnd);

    expect(preload).not.toContain("desktopControlToken");
    expect(preload).not.toContain("backendControlToken");
    expect(preload).not.toContain("local-introduction");
    expect(rendererBootstrapHandler).not.toContain("backendControlToken");
    expect(rendererBootstrapHandler).not.toContain("desktopControlToken");
    expect(rendererBootstrapHandler).toContain("bootstrapToken: backendBootstrapToken");
  });

  it("keeps the durable E2EE agreement scalar behind Desktop main", () => {
    const main = source("main.ts");
    const preload = source("preload.ts");

    expect(main).toContain("DesktopNativeE2eeHandshakeService");
    expect(preload).toContain("beginDesktopWorkspaceVerification");
    expect(preload).not.toContain("startNativeE2eeHandshake");
    expect(preload).not.toContain("finishNativeE2eeHandshake");
    expect(preload).not.toContain("agreementSecretKey");
    expect(preload).not.toContain("withAgreementSecretKey");
  });
});
