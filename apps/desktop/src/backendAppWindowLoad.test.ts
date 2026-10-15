import { describe, expect, it } from "vite-plus/test";

import {
  EARLY_APP_LOAD_COMMIT_TIMEOUT_MS,
  EARLY_APP_LOAD_MAX_HOLD_MS,
  isAppLoadAwaitingCommit,
  isAppLoadRequestCurrent,
  isEarlyAppLoadStalled,
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

  it("reloads a usable app whose renderer process died instead of nudging it", () => {
    // A crashed renderer keeps its URL but cannot run the reconnect.
    expect(
      resolveBackendAppWindowAction({
        currentUrl: `${backendHttpUrl}/threads/abc`,
        backendHttpUrl,
        isBootUrl,
        shellUsable: true,
        rendererGone: true,
      }),
    ).toBe("load");
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

  it("measures the hold from the document's commit, not from the request", () => {
    // The backend stalled before serving the document: it committed 14 s
    // after the request, and readiness came 3 s later. Its held requests are
    // 3 s old, so the document stands.
    const request = { backend, requestedAtMs: 1_000, committedAtMs: 15_000, failed: false };
    expect(isAppLoadRequestCurrent({ request, backend, nowMs: 18_000 })).toBe(true);
    expect(
      isAppLoadRequestCurrent({ request, backend, nowMs: 15_000 + EARLY_APP_LOAD_MAX_HOLD_MS }),
    ).toBe(false);
  });

  it("no longer stands once its navigation failed, so readiness loads again", () => {
    const request = { backend, requestedAtMs: 1_000, failed: true };
    expect(isAppLoadRequestCurrent({ request, backend, nowMs: 1_500 })).toBe(false);
  });
});

describe("early app load commit", () => {
  const backend = {};
  const started = (overrides: { committedAtMs?: number; failed?: boolean } = {}) => ({
    backend,
    requestedAtMs: 1_000,
    navigationStartedAtMs: 1_000,
    failed: false,
    ...overrides,
  });
  const stalled = (input: {
    request: Parameters<typeof isEarlyAppLoadStalled>[0]["request"];
    currentUrl?: string;
    backendStarting?: boolean;
    nowMs?: number;
  }) =>
    isEarlyAppLoadStalled({
      request: input.request,
      currentUrl: input.currentUrl ?? "",
      backendStarting: input.backendStarting ?? true,
      nowMs: input.nowMs ?? 1_000 + EARLY_APP_LOAD_COMMIT_TIMEOUT_MS,
    });

  it("waits on a started navigation until it commits or fails", () => {
    expect(isAppLoadAwaitingCommit(started())).toBe(true);
    expect(isAppLoadAwaitingCommit(started({ committedAtMs: 1_200 }))).toBe(false);
    expect(isAppLoadAwaitingCommit(started({ failed: true }))).toBe(false);
    // Still waiting for cache maintenance: the boot page keeps loading.
    expect(isAppLoadAwaitingCommit({ backend, requestedAtMs: 1_000, failed: false })).toBe(false);
    expect(isAppLoadAwaitingCommit(undefined)).toBe(false);
  });

  it("gives up an uncommitted early load over an empty window while the backend stalls", () => {
    expect(stalled({ request: started() })).toBe(true);
    expect(stalled({ request: started(), currentUrl: "about:blank" })).toBe(true);
  });

  it("keeps an early load that committed, is young, or whose backend already serves", () => {
    expect(stalled({ request: started({ committedAtMs: 1_200 }) })).toBe(false);
    expect(
      stalled({ request: started(), nowMs: 1_000 + EARLY_APP_LOAD_COMMIT_TIMEOUT_MS - 1 }),
    ).toBe(false);
    // Once the backend serves nothing would load the app again.
    expect(stalled({ request: started(), backendStarting: false })).toBe(false);
    // A committed boot page stays visible under the pending navigation.
    expect(stalled({ request: started(), currentUrl: "file:///app/desktop-boot.html" })).toBe(
      false,
    );
  });
});
