import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";

function installDesktopWindow(getLocalEnvironmentBootstrap: () => unknown) {
  const bridge = { getLocalEnvironmentBootstrap };
  vi.stubGlobal("window", {
    location: new URL("http://127.0.0.1:7926/"),
    desktopBridge: bridge,
  });
  return bridge;
}

describe("desktop primary environment target", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the desktop bootstrap once per bridge instead of per URL or render", () => {
    const getLocalEnvironmentBootstrap = vi.fn(() => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:7926",
      wsBaseUrl: "ws://127.0.0.1:7926",
    }));
    installDesktopWindow(getLocalEnvironmentBootstrap);

    expect(resolvePrimaryEnvironmentHttpUrl("/api/a")).toBe("http://127.0.0.1:7926/api/a");
    expect(resolvePrimaryEnvironmentHttpUrl("/api/b")).toBe("http://127.0.0.1:7926/api/b");
    expect(readPrimaryEnvironmentTarget()?.source).toBe("desktop-managed");
    expect(getLocalEnvironmentBootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while the desktop has no backend URL yet", () => {
    const getLocalEnvironmentBootstrap = vi
      .fn()
      .mockReturnValueOnce({ label: "Local environment", httpBaseUrl: null, wsBaseUrl: null })
      .mockReturnValue({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:7926",
        wsBaseUrl: "ws://127.0.0.1:7926",
      });
    installDesktopWindow(getLocalEnvironmentBootstrap);

    expect(readPrimaryEnvironmentTarget()?.source).toBe("window-origin");
    expect(readPrimaryEnvironmentTarget()?.source).toBe("desktop-managed");
    expect(readPrimaryEnvironmentTarget()?.source).toBe("desktop-managed");
    expect(getLocalEnvironmentBootstrap).toHaveBeenCalledTimes(2);
  });
});
