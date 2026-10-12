import { describe, expect, it } from "vite-plus/test";

import {
  EARLY_APP_LOAD_MAX_HOLD_MS,
  isAppLoadRequestCurrent,
  resolveBackendAppWindowAction,
} from "./backendAppWindowLoad.ts";

const backendHttpUrl = "http://127.0.0.1:7926";
const isBootUrl = (url: string) => url.endsWith("/desktop-boot.html");

function action(currentUrl: string, shellUsable: boolean) {
  return resolveBackendAppWindowAction({ currentUrl, backendHttpUrl, isBootUrl, shellUsable });
}

describe("resolveBackendAppWindowAction", () => {
  it("loads the app from the boot page or an empty window", () => {
    expect(action("file:///app/desktop-boot.html", false)).toBe("load");
    expect(action("about:blank", false)).toBe("load");
    expect(action("", false)).toBe("load");
  });

  it("keeps a booted app and its route across a backend crash restart", () => {
    expect(action(`${backendHttpUrl}/threads/abc?panel=diff`, true)).toBe("reconnect");
  });

  it("reloads a document on the backend origin that never became usable", () => {
    // An error page from a load that hit the dying backend keeps the failed
    // URL, and a half-booted app has no live connection to resume.
    expect(action(`${backendHttpUrl}/`, false)).toBe("load");
    expect(action(`${backendHttpUrl}/threads/abc`, false)).toBe("load");
  });

  it("leaves windows showing another origin alone", () => {
    expect(action("https://example.com/", true)).toBe("ignore");
    expect(action("http://127.0.0.1:3773/", true)).toBe("ignore");
  });

  it("loads the app from the boot page as soon as the backend's port is bound", () => {
    const bound = (currentUrl: string, shellUsable: boolean) =>
      resolveBackendAppWindowAction({
        currentUrl,
        backendHttpUrl,
        isBootUrl,
        shellUsable,
        moment: "bound",
      });
    expect(bound("file:///app/desktop-boot.html", false)).toBe("load");
    expect(bound("about:blank", false)).toBe("load");
    // Reconnecting or replacing a backend-origin document waits for readiness.
    expect(bound(`${backendHttpUrl}/threads/abc`, true)).toBe("ignore");
    expect(bound(`${backendHttpUrl}/`, false)).toBe("ignore");
  });

  it("does not repeat an app load already requested from the same backend", () => {
    // Requested at bind time: the URL may still show the boot page until the
    // navigation commits, and the shell is not usable yet.
    for (const currentUrl of ["file:///app/desktop-boot.html", `${backendHttpUrl}/`]) {
      expect(
        resolveBackendAppWindowAction({
          currentUrl,
          backendHttpUrl,
          isBootUrl,
          shellUsable: false,
          loadRequestedFromThisBackend: true,
          moment: "ready",
        }),
      ).toBe("ignore");
    }
  });
});

describe("isAppLoadRequestCurrent", () => {
  const backend = {};

  it("holds for the backend it was requested from while its requests can still be held", () => {
    const request = { backend, requestedAtMs: 1_000, failed: false };
    expect(isAppLoadRequestCurrent({ request, backend, nowMs: 1_500 })).toBe(true);
    expect(isAppLoadRequestCurrent({ request, backend: {}, nowMs: 1_500 })).toBe(false);
    expect(isAppLoadRequestCurrent({ request, backend: null, nowMs: 1_500 })).toBe(false);
    expect(isAppLoadRequestCurrent({ request: undefined, backend, nowMs: 1_500 })).toBe(false);
  });

  it("lapses once the backend's request hold may have answered 503", () => {
    const request = { backend, requestedAtMs: 1_000, failed: false };
    expect(
      isAppLoadRequestCurrent({ request, backend, nowMs: 1_000 + EARLY_APP_LOAD_MAX_HOLD_MS }),
    ).toBe(false);
  });

  it("no longer stands once its navigation failed, so readiness loads again", () => {
    const request = { backend, requestedAtMs: 1_000, failed: true };
    expect(isAppLoadRequestCurrent({ request, backend, nowMs: 1_500 })).toBe(false);
  });
});
