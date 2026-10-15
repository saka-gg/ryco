import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  canListenOnHost,
  DEFAULT_DESKTOP_BACKEND_PORT,
  DESKTOP_RENDERER_ORIGIN_RECORD_FILE,
  hasPriorDesktopRendererState,
  LEGACY_DESKTOP_BACKEND_PORT,
  readDesktopRendererOriginPort,
  resolveDesktopBackendPort,
  resolveDesktopBackendStartPort,
  resolveDesktopPersistedBackendPort,
  shouldPersistDesktopBackendPort,
  writeDesktopRendererOriginPort,
} from "./backendPort.ts";

describe("resolveDesktopBackendPort", () => {
  it("returns the starting port when it is available", async () => {
    const canListenOnHost = vi.fn(async (port: number) => port === 3773);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3773);

    expect(canListenOnHost).toHaveBeenCalledTimes(1);
    expect(canListenOnHost).toHaveBeenCalledWith(3773, "127.0.0.1");
  });

  it("increments sequentially until it finds an available port", async () => {
    const canListenOnHost = vi.fn(async (port: number) => port === 3775);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3775);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3774, "127.0.0.1"],
      [3775, "127.0.0.1"],
    ]);
  });

  it("treats wildcard-bound ports as unavailable even when loopback probing succeeds", async () => {
    const canListenOnHost = vi.fn(async (port: number, host: string) => {
      if (port === 3773 && host === "127.0.0.1") return true;
      if (port === 3773 && host === "0.0.0.0") return false;
      return port === 3774;
    });

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        requiredHosts: ["0.0.0.0"],
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3774);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3773, "0.0.0.0"],
      [3774, "127.0.0.1"],
      [3774, "0.0.0.0"],
    ]);
  });

  it("checks overlapping hosts sequentially to avoid self-interference", async () => {
    let inFlightCount = 0;
    const canListenOnHost = vi.fn(async (_port: number, _host: string) => {
      inFlightCount += 1;
      const overlapped = inFlightCount > 1;
      await Promise.resolve();
      inFlightCount -= 1;
      return !overlapped;
    });

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        requiredHosts: ["0.0.0.0", "::"],
        startPort: 3773,
        maxPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3773);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3773, "0.0.0.0"],
      [3773, "::"],
    ]);
  });

  it("fails when the scan range is exhausted", async () => {
    const canListenOnHost = vi.fn(async () => false);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 65534,
        maxPort: 65535,
        canListenOnHost,
      }),
    ).rejects.toThrow(
      "No desktop backend port is available on hosts 127.0.0.1 between 65534 and 65535",
    );

    expect(canListenOnHost.mock.calls).toEqual([
      [65534, "127.0.0.1"],
      [65535, "127.0.0.1"],
    ]);
  });
});

describe("desktop backend port selection", () => {
  it("probes the port the last launch served on before any default", () => {
    expect(
      resolveDesktopBackendStartPort({ persistedPort: 3775, hasPriorRendererState: true }),
    ).toBe(3775);
  });

  it("keeps existing installations on the legacy port so their origin and drafts stay put", () => {
    expect(
      resolveDesktopBackendStartPort({ persistedPort: null, hasPriorRendererState: true }),
    ).toBe(LEGACY_DESKTOP_BACKEND_PORT);
  });

  it("gives new installations a Ryco-specific port that T3 Code does not use", () => {
    expect(DEFAULT_DESKTOP_BACKEND_PORT).not.toBe(LEGACY_DESKTOP_BACKEND_PORT);
    expect(
      resolveDesktopBackendStartPort({ persistedPort: null, hasPriorRendererState: false }),
    ).toBe(DEFAULT_DESKTOP_BACKEND_PORT);
  });

  it("recognizes an installation that already has renderer state", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-backend-port-test-"));
    try {
      expect(hasPriorDesktopRendererState(directory)).toBe(false);
      FS.mkdirSync(Path.join(directory, "Local Storage"));
      expect(hasPriorDesktopRendererState(directory)).toBe(true);
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("probes with a plain listen and reports a held port as busy", async () => {
    const server = Net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(canListenOnHost(port, "127.0.0.1")).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(canListenOnHost(port, "127.0.0.1")).resolves.toBe(true);
  });
});

describe("shouldPersistDesktopBackendPort", () => {
  it("persists the preferred port when it served", () => {
    expect(
      shouldPersistDesktopBackendPort({
        servedPort: 3773,
        preferredPort: 3773,
        persistedPort: null,
        hasPriorRendererState: true,
      }),
    ).toBe(true);
    expect(
      shouldPersistDesktopBackendPort({
        servedPort: 7926,
        preferredPort: 7926,
        persistedPort: 7926,
        hasPriorRendererState: true,
      }),
    ).toBe(true);
  });

  it("never lets a one-launch fallback replace the persisted port", () => {
    // T3 Code (or an orphaned backend) held the persisted port this launch.
    expect(
      shouldPersistDesktopBackendPort({
        servedPort: 7927,
        preferredPort: 7926,
        persistedPort: 7926,
        hasPriorRendererState: true,
      }),
    ).toBe(false);
  });

  it("keeps an existing install on its legacy origin when that port is busy once", () => {
    expect(
      shouldPersistDesktopBackendPort({
        servedPort: 3774,
        preferredPort: LEGACY_DESKTOP_BACKEND_PORT,
        persistedPort: null,
        hasPriorRendererState: true,
      }),
    ).toBe(false);
  });

  it("remembers a fresh install's first port even when it is a fallback", () => {
    expect(
      shouldPersistDesktopBackendPort({
        servedPort: DEFAULT_DESKTOP_BACKEND_PORT + 1,
        preferredPort: DEFAULT_DESKTOP_BACKEND_PORT,
        persistedPort: null,
        hasPriorRendererState: false,
      }),
    ).toBe(true);
  });
});

describe("renderer origin record", () => {
  function withUserData(run: (directory: string) => void): void {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-renderer-origin-test-"));
    try {
      run(directory);
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  }

  it("round-trips the port, owner-only", () => {
    withUserData((directory) => {
      expect(readDesktopRendererOriginPort(directory)).toBeNull();
      writeDesktopRendererOriginPort(directory, DEFAULT_DESKTOP_BACKEND_PORT);
      expect(readDesktopRendererOriginPort(directory)).toBe(DEFAULT_DESKTOP_BACKEND_PORT);
      writeDesktopRendererOriginPort(directory, 7_931);
      expect(readDesktopRendererOriginPort(directory)).toBe(7_931);
      const recordPath = Path.join(directory, DESKTOP_RENDERER_ORIGIN_RECORD_FILE);
      if (process.platform !== "win32") {
        expect(FS.statSync(recordPath).mode & 0o777).toBe(0o600);
      }
      expect(FS.readdirSync(directory)).toEqual([DESKTOP_RENDERER_ORIGIN_RECORD_FILE]);
    });
  });

  it("ignores a damaged or foreign record", () => {
    withUserData((directory) => {
      const recordPath = Path.join(directory, DESKTOP_RENDERER_ORIGIN_RECORD_FILE);
      for (const content of ["{", "null", '{"version":2,"port":7926}', '{"version":1,"port":0}']) {
        FS.writeFileSync(recordPath, content);
        expect(readDesktopRendererOriginPort(directory), content).toBeNull();
      }
    });
  });

  it("prefers the record over the desktop settings port", () => {
    expect(resolveDesktopPersistedBackendPort({ recordedPort: 7926, settingsPort: 3773 })).toBe(
      7926,
    );
    expect(resolveDesktopPersistedBackendPort({ recordedPort: null, settingsPort: 3773 })).toBe(
      3773,
    );
    expect(
      resolveDesktopPersistedBackendPort({ recordedPort: null, settingsPort: null }),
    ).toBeNull();
  });

  it("keeps an install on its port when the Ryco home was reset but userData survived", () => {
    withUserData((directory) => {
      // The first launch recorded its origin; it created renderer state but
      // never reached readiness, and the settings file was then lost.
      writeDesktopRendererOriginPort(directory, DEFAULT_DESKTOP_BACKEND_PORT);
      FS.mkdirSync(Path.join(directory, "Local Storage"));
      const persistedPort = resolveDesktopPersistedBackendPort({
        recordedPort: readDesktopRendererOriginPort(directory),
        settingsPort: null,
      });
      expect(
        resolveDesktopBackendStartPort({
          persistedPort,
          hasPriorRendererState: hasPriorDesktopRendererState(directory),
        }),
      ).toBe(DEFAULT_DESKTOP_BACKEND_PORT);
    });
  });
});
