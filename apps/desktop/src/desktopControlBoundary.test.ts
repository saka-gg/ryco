import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

describe("Desktop-main local control credential boundary", () => {
  it("passes a fresh per-child credential only through the inherited bootstrap pipe", () => {
    const main = source("main.ts");
    const start = main.indexOf("function startBackend(): void");
    const stop = main.indexOf("async function stopBackendAndWaitForExit(", start);
    const startBackend = main.slice(start, stop);

    expect(startBackend).toContain('Crypto.randomBytes(32).toString("base64url")');
    expect(startBackend).toContain("desktopControlToken: childControlToken");
    expect(startBackend).toContain('stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]');
    expect(startBackend).toContain("const bootstrapStream = child.stdio[3]");
    expect(startBackend).toContain("desktopTelemetryFd: 4");
    expect(startBackend).not.toContain("process.env.desktopControlToken");
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
