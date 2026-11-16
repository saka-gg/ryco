import { describe, expect, it, vi } from "vite-plus/test";
import type {
  AppLifecycleService,
  AttachmentCodecService,
  ClientRuntimeConfigService,
  ClockService,
  EndpointService,
  FrameSchedulerService,
  HttpClientService,
  KVService,
  ObservabilityService,
  PasskeyCeremonyService,
  SecretKVService,
  SessionCredentialsService,
  SocketService,
} from "@ryco/client-runtime/platform";

// Native modules are stubbed so the adapters load under the Node test runner,
// matching the upstream mobile test pattern.
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
const { passkeyGet, passkeyCreate } = vi.hoisted(() => ({
  passkeyGet: vi.fn(),
  passkeyCreate: vi.fn(),
}));
vi.mock("react-native-passkey", () => ({
  Passkey: { get: passkeyGet, create: passkeyCreate, isSupported: () => true },
}));

import { mobileAppLifecycle } from "./appLifecycle";
import { mobileAttachmentCodec } from "./attachmentCodec";
import { readMobileClientRuntimeConfig } from "./config";
import { createMobileEndpoint } from "./endpoint";
import { mobileClock, mobileFrameScheduler } from "./frame";
import { createMobileHttpClient } from "./httpClient";
import { createMobileKV } from "./kv";
import { mobileObservability } from "./observability";
import { mobilePasskeyCeremony } from "./passkeyCeremony";
import { createMobileSecretKV, sanitizeSecretKey } from "./secretKv";
import { createMobileSessionCredentials } from "./sessionCredentials";
import { mobileSocket } from "./socket";

const nodeConfig: ClientRuntimeConfigService = {
  clientMode: "standard",
  httpBaseUrl: "http://node.local:44342",
  wsBaseUrl: "ws://node.local:44342",
};

describe("mobile platform adapters", () => {
  it("implements each platform contract with an RN primitive", () => {
    const adapters = [
      mobileAppLifecycle satisfies AppLifecycleService,
      mobileAttachmentCodec satisfies AttachmentCodecService,
      mobileClock satisfies ClockService,
      createMobileEndpoint(nodeConfig) satisfies EndpointService,
      mobileFrameScheduler satisfies FrameSchedulerService,
      createMobileHttpClient(() => null) satisfies HttpClientService,
      createMobileKV() satisfies KVService,
      mobileObservability satisfies ObservabilityService,
      mobilePasskeyCeremony satisfies PasskeyCeremonyService,
      createMobileSecretKV() satisfies SecretKVService,
      mobileSocket satisfies SocketService,
      createMobileSessionCredentials() satisfies SessionCredentialsService,
      readMobileClientRuntimeConfig() satisfies ClientRuntimeConfigService,
    ];

    expect(adapters).toHaveLength(13);
  });

  it("keeps the bearer session mode with an in-memory CSRF holder", () => {
    const credentials = createMobileSessionCredentials();
    expect(credentials.mode).toBe("bearer");
    expect(credentials.readCsrfToken()).toBeNull();
    credentials.writeCsrfToken("csrf");
    expect(credentials.readCsrfToken()).toBe("csrf");
    credentials.writeCsrfToken(null);
    expect(credentials.readCsrfToken()).toBeNull();
  });

  it("adapts an async key-value store to the KV contract", async () => {
    const store = new Map<string, string>();
    const kv = createMobileKV({
      getItem: async (key) => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value);
      },
      removeItem: async (key) => {
        store.delete(key);
      },
    });
    await kv.setItem("draft", "value");
    expect(await kv.getItem("draft")).toBe("value");
    await kv.removeItem("draft");
    expect(await kv.getItem("draft")).toBeNull();
  });

  it("round-trips a passkey assertion through the native ceremony seam", async () => {
    const ceremony: PasskeyCeremonyService = mobilePasskeyCeremony;
    passkeyGet.mockResolvedValueOnce({
      id: "Y3JlZC1pZA",
      rawId: "Y3JlZC1pZA",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln" },
    });

    const response = await ceremony.authenticate({
      challenge: new Uint8Array([1, 2, 3]),
      rpId: "app.ryco.space",
      allowCredentials: [{ id: new Uint8Array([4, 5]), type: "public-key" }],
    });

    // Options reach native base64url-encoded, with the server's RP ID intact.
    expect(passkeyGet).toHaveBeenCalledWith({
      challenge: "AQID",
      rpId: "app.ryco.space",
      allowCredentials: [{ type: "public-key", id: "BAU" }],
    });
    expect(response).toEqual({
      id: "Y3JlZC1pZA",
      rawId: "Y3JlZC1pZA",
      response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln" },
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    });
  });

  it("round-trips a passkey registration through the native ceremony seam", async () => {
    passkeyCreate.mockResolvedValueOnce({
      id: "Y3JlZC1pZA",
      rawId: "Y3JlZC1pZA",
      type: "public-key",
      response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0" },
    });

    const response = await mobilePasskeyCeremony.register({
      challenge: new Uint8Array([1, 2, 3]),
      rp: { name: "Ryco", id: "app.ryco.space" },
      user: { id: new Uint8Array([6, 7]), name: "owner@example.test", displayName: "Owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });

    expect(passkeyCreate).toHaveBeenCalledWith({
      challenge: "AQID",
      rp: { id: "app.ryco.space", name: "Ryco" },
      user: { id: "Bgc", name: "owner@example.test", displayName: "Owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
    expect(response.type).toBe("public-key");
    expect(response.response.attestationObject).toBe("YXR0");
  });

  it("bounds a native ceremony failure instead of surfacing native detail", async () => {
    passkeyGet.mockRejectedValueOnce({
      error: "Native error",
      message: "challenge=LEAKED-CHALLENGE",
    });

    const failure = await mobilePasskeyCeremony
      .authenticate({ challenge: new Uint8Array([1]), rpId: "app.ryco.space" })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe("Passkey ceremony failed.");
    expect(JSON.stringify(failure?.message)).not.toContain("LEAKED-CHALLENGE");
  });

  it("resolves relative pathnames against the configured origin", async () => {
    const calls: string[] = [];
    const globalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;
    try {
      const http = createMobileHttpClient(() => "http://node.local:44342");
      await http.fetch("/api/auth/bootstrap/bearer");
      await http.fetch("https://other.host/x");
      expect(calls).toEqual([
        "http://node.local:44342/api/auth/bootstrap/bearer",
        "https://other.host/x",
      ]);
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it("derives a configured primary target and resolves urls from the endpoint", () => {
    const endpoint = createMobileEndpoint(nodeConfig);
    expect(endpoint.origin()).toBe("http://node.local:44342");
    expect(endpoint.readPrimaryTarget()).toEqual({
      source: "configured",
      target: { httpBaseUrl: "http://node.local:44342", wsBaseUrl: "ws://node.local:44342" },
    });
    expect(endpoint.resolveHttpUrl("/api/threads", { limit: "10" })).toBe(
      "http://node.local:44342/api/threads?limit=10",
    );
    expect(endpoint.resolveWsUrl("/ws")).toBe("ws://node.local:44342/ws");
  });

  it("returns no primary target when nothing is configured", () => {
    const endpoint = createMobileEndpoint({ clientMode: "standard" });
    expect(endpoint.readPrimaryTarget()).toBeNull();
    expect(endpoint.origin()).toBe("");
  });

  it("sanitizes secret keys to the SecureStore charset", () => {
    expect(sanitizeSecretKey("env-123.abc")).toBe("env-123.abc");
    expect(sanitizeSecretKey("ws:label/path")).toBe("ws_003alabel_002fpath");
    // `_` is reserved as the escape introducer, so a literal `_` is escaped too.
    expect(sanitizeSecretKey("a_b")).toBe("a_005fb");
  });

  it("routes secret writes through SecureStore and reports failure as false", async () => {
    const backing = new Map<string, string>();
    let failNext = false;
    const secretKv = createMobileSecretKV({
      getItemAsync: async (key) => backing.get(key) ?? null,
      setItemAsync: async (key, value) => {
        if (failNext) throw new Error("keychain unavailable");
        backing.set(key, value);
      },
      deleteItemAsync: async (key) => {
        backing.delete(key);
      },
    });
    expect(await secretKv.set("env-1", "token")).toBe(true);
    expect(await secretKv.get("env-1")).toBe("token");
    failNext = true;
    expect(await secretKv.set("env-1", "token2")).toBe(false);
    await secretKv.remove("env-1");
    expect(await secretKv.get("env-1")).toBeNull();
  });

  it("round-trips a uri attachment through the neutral value", async () => {
    const encoded = await mobileAttachmentCodec.encode({
      id: "img-1",
      mime: "image/png",
      size: 3,
      uri: "file:///tmp/img.png",
    });
    expect(encoded).toEqual({
      id: "img-1",
      mime: "image/png",
      size: 3,
      uri: "file:///tmp/img.png",
    });
    await expect(mobileAttachmentCodec.decode(encoded)).resolves.toEqual({
      id: "img-1",
      mime: "image/png",
      size: 3,
      uri: "file:///tmp/img.png",
    });
  });

  it("reports foreground and a live clock/frame", async () => {
    expect(mobileAppLifecycle.isForeground()).toBe(true);
    expect(Number.isFinite(mobileClock.now())).toBe(true);
    await new Promise<void>((resolve) => mobileFrameScheduler.scheduleFrame(resolve));
  });
});
