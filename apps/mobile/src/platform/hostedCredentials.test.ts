import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SecretKVService,
} from "@ryco/client-runtime/platform";
import { HostedHubApi, HostedHubApiError } from "@ryco/client-runtime/authorization";
import {
  createDpopProofSigner,
  decodeBase64Url,
  type DpopPublicJwk,
} from "@ryco/client-runtime/relay";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMobileSessionCredentials, HOSTED_SESSION_TOKEN_KEY } from "./sessionCredentials";

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

function fakeSecretKV(seed: ReadonlyMap<string, string> = new Map()): {
  service: SecretKVService;
  store: Map<string, string>;
} {
  const store = new Map(seed);
  return {
    store,
    service: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
        return true;
      },
      remove: async (key) => {
        store.delete(key);
      },
    },
  };
}

/** A fake hardware key: the shape `createDpopProofSigner` needs, no native. */
function fakeSigningKey() {
  return {
    algorithm: "ES256" as const,
    publicJwk: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
    sign: async () => new Uint8Array(64).fill(7),
  };
}

const HUB_ORIGIN = "https://hub.example.test";

const apiDependencies = () => ({
  endpoint: {
    origin: () => HUB_ORIGIN,
    readPrimaryTarget: () => null,
    resolveHttpUrl: (pathname: string) => new URL(pathname, HUB_ORIGIN).toString(),
    resolveWsUrl: (wsBaseUrl: string) => wsBaseUrl,
  } satisfies EndpointService,
  httpClient: { fetch: async () => new Response("{}", { status: 200 }) } as HttpClientService,
  passkeyCeremony: {
    authenticate: async () => {
      throw new Error("unused");
    },
    register: async () => {
      throw new Error("unused");
    },
  } as unknown as PasskeyCeremonyService,
});

describe("bearer session credentials", () => {
  it("constructs HostedHubApi without throwing", () => {
    // Direct regression guard for the bootstrap crash: HostedHubApi's
    // constructor rejects a bearer adapter that lacks a DPoP signer or a
    // bearer-token holder, and configureHostedRuntime builds the API eagerly,
    // so this threw at app boot rather than at first request.
    expect(
      () =>
        new HostedHubApi({
          ...apiDependencies(),
          sessionCredentials: createMobileSessionCredentials(fakeSecretKV().service),
          dpopSigner: createDpopProofSigner(fakeSigningKey(), {
            now: () => 1_700_000_000_000,
            randomJti: () => "jti-1",
            sha256: async () => new Uint8Array(32).fill(1),
          }),
        }),
    ).not.toThrow();
  });

  it("still throws when the DPoP signer is omitted", () => {
    let thrown: unknown;
    try {
      const api = new HostedHubApi({
        ...apiDependencies(),
        sessionCredentials: createMobileSessionCredentials(fakeSecretKV().service),
      });
      void api;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostedHubApiError);
    expect((thrown as HostedHubApiError).reason).toBe("missing-signer");
    expect((thrown as Error).message).toContain("Secure session signing is unavailable");
  });

  it("reads back a token written through the holder", () => {
    const credentials = createMobileSessionCredentials(fakeSecretKV().service);

    expect(credentials.readBearerToken?.()).toBeNull();
    credentials.writeBearerToken?.("token-value");
    expect(credentials.readBearerToken?.()).toBe("token-value");
  });

  it("hydrates a persisted token into the synchronous holder", async () => {
    const kv = fakeSecretKV(new Map([[HOSTED_SESSION_TOKEN_KEY, "persisted-token"]]));
    const credentials = createMobileSessionCredentials(kv.service);

    expect(credentials.readBearerToken?.()).toBeNull();
    await credentials.hydrate();

    expect(credentials.readBearerToken?.()).toBe("persisted-token");
  });

  it("mirrors a written token to the secret store", async () => {
    const kv = fakeSecretKV();
    const credentials = createMobileSessionCredentials(kv.service);

    credentials.writeBearerToken?.("t");
    await Promise.resolve();

    expect(kv.store.get(HOSTED_SESSION_TOKEN_KEY)).toBe("t");
  });

  it("commits a minted token only after durable read-back", async () => {
    const kv = fakeSecretKV();
    const credentials = createMobileSessionCredentials(kv.service);

    await expect(credentials.commitBearerToken("native-token")).resolves.toBe(true);
    expect(credentials.readBearerToken?.()).toBe("native-token");
    expect(kv.store.get(HOSTED_SESSION_TOKEN_KEY)).toBe("native-token");
  });

  it("does not publish a token when the secure store refuses the write", async () => {
    const credentials = createMobileSessionCredentials({
      get: async () => null,
      set: async () => false,
      remove: async () => {},
    });

    await expect(credentials.commitBearerToken("native-token")).resolves.toBe(false);
    expect(credentials.readBearerToken?.()).toBeNull();
  });

  it("clears both the cache and the secret store on sign-out", async () => {
    const kv = fakeSecretKV(new Map([[HOSTED_SESSION_TOKEN_KEY, "t"]]));
    const credentials = createMobileSessionCredentials(kv.service);
    await credentials.hydrate();

    credentials.writeBearerToken?.(null);
    await Promise.resolve();

    expect(credentials.readBearerToken?.()).toBeNull();
    expect(kv.store.has(HOSTED_SESSION_TOKEN_KEY)).toBe(false);
  });

  it("never lets a delayed write resurrect a token cleared by sign-out", async () => {
    // Unsequenced writes let a slow `set` land after the `remove` issued by
    // sign-out, leaving live session material in SecretKV that the next launch
    // would hydrate back — the holder clear but the session resurrected.
    const kv = fakeSecretKV();
    let releaseSet: (() => void) | undefined;
    const credentials = createMobileSessionCredentials({
      ...kv.service,
      set: async (key, value) => {
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        kv.store.set(key, value);
        return true;
      },
    });

    credentials.writeBearerToken?.("token-value");
    credentials.writeBearerToken?.(null);
    releaseSet?.();
    // Let both queued persistence operations settle.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

    expect(credentials.readBearerToken?.()).toBeNull();
    expect(kv.store.has(HOSTED_SESSION_TOKEN_KEY)).toBe(false);
  });

  it("waits for durable removal before a Hub-domain change continues", async () => {
    const kv = fakeSecretKV();
    let releaseSet: (() => void) | undefined;
    const credentials = createMobileSessionCredentials({
      ...kv.service,
      set: async (key, value) => {
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        kv.store.set(key, value);
        return true;
      },
    });

    credentials.writeBearerToken?.("old-hub-token");
    const clearing = credentials.clearBearerToken();
    expect(credentials.readBearerToken?.()).toBeNull();
    await Promise.resolve();
    releaseSet?.();
    await clearing;

    expect(kv.store.has(HOSTED_SESSION_TOKEN_KEY)).toBe(false);
  });

  it("fails a Hub-domain change closed when durable removal fails", async () => {
    const credentials = createMobileSessionCredentials({
      get: async () => "old-hub-token",
      set: async () => true,
      remove: async () => {
        throw new Error("raw keychain details");
      },
    });
    await credentials.hydrate();

    await expect(credentials.clearBearerToken()).rejects.toThrow(
      "The Hub credential could not be cleared.",
    );
    expect(credentials.readBearerToken?.()).toBeNull();
  });

  it("hydrates at most once", async () => {
    const kv = fakeSecretKV(new Map([[HOSTED_SESSION_TOKEN_KEY, "t"]]));
    const get = vi.fn(kv.service.get);
    const credentials = createMobileSessionCredentials({ ...kv.service, get });

    await Promise.all([credentials.hydrate(), credentials.hydrate()]);
    await credentials.hydrate();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not let hydration clobber a newer token", async () => {
    const kv = fakeSecretKV(new Map([[HOSTED_SESSION_TOKEN_KEY, "stale"]]));
    const credentials = createMobileSessionCredentials(kv.service);

    const hydrating = credentials.hydrate();
    credentials.writeBearerToken?.("fresh");
    await hydrating;

    expect(credentials.readBearerToken?.()).toBe("fresh");
  });

  it("retries a locked secret store without replacing its session", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("locked")).mockResolvedValue("stored");
    const credentials = createMobileSessionCredentials({
      ...fakeSecretKV().service,
      get,
    });
    await expect(credentials.hydrate()).rejects.toThrow("credential store is unavailable");
    await credentials.hydrate();
    expect(credentials.readBearerToken?.()).toBe("stored");
  });

  it("does not restore a credential after sign-out while hydration is pending", async () => {
    let finishRead!: (value: string) => void;
    const credentials = createMobileSessionCredentials({
      ...fakeSecretKV().service,
      get: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    });
    const hydration = credentials.hydrate();
    await credentials.clearBearerToken();
    finishRead("stale");
    await hydration;
    expect(credentials.readBearerToken?.()).toBeNull();
  });

  it("does not publish a pending durable commit after sign-out", async () => {
    let finishRead!: (value: string) => void;
    const readStarted = Promise.withResolvers<void>();
    const credentials = createMobileSessionCredentials({
      ...fakeSecretKV().service,
      get: () =>
        new Promise((resolve) => {
          finishRead = resolve;
          readStarted.resolve();
        }),
    });
    const commit = credentials.commitBearerToken("new-token");
    await readStarted.promise;
    const clear = credentials.clearBearerToken();
    finishRead("new-token");
    await expect(commit).resolves.toBe(false);
    expect(credentials.readBearerToken?.()).toBeNull();
    await clear;
  });

  it("keeps the token out of any serialized form of the adapter", () => {
    const credentials = createMobileSessionCredentials(fakeSecretKV().service);
    credentials.writeBearerToken?.("super-secret-token");

    expect(JSON.stringify(credentials)).not.toContain("super-secret-token");
    expect(Object.values(credentials).join(" ")).not.toContain("super-secret-token");
  });
});

describe("DPoP proof construction over the mobile signer shape", () => {
  const context = {
    now: () => 1_700_000_000_000,
    randomJti: (() => {
      let counter = 0;
      return () => `jti-${(counter += 1)}`;
    })(),
    sha256: async (bytes: Uint8Array) => new Uint8Array(32).fill(bytes.length % 251),
  };

  function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as Record<
      string,
      unknown
    >;
  }

  it("emits a public-only ES256 header", async () => {
    const signer = createDpopProofSigner(fakeSigningKey(), context);
    const proof = await signer.sign({ method: "get", url: "https://hub.example.test/api/nodes" });

    const header = decodeSegment(proof.split(".")[0]!);
    expect(header).toEqual({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
    });
  });

  it("uppercases htm and strips query and fragment from htu", async () => {
    const signer = createDpopProofSigner(fakeSigningKey(), context);
    const proof = await signer.sign({
      method: "get",
      url: "https://hub.example.test/api/nodes?page=2#frag",
    });

    const payload = decodeSegment(proof.split(".")[1]!);
    expect(payload.htm).toBe("GET");
    expect(payload.htu).toBe("https://hub.example.test/api/nodes");
  });

  it("includes ath only when a token is presented", async () => {
    const signer = createDpopProofSigner(fakeSigningKey(), context);

    const mint = decodeSegment(
      (await signer.sign({ method: "POST", url: "https://hub.example.test/api/auth/x" })).split(
        ".",
      )[1]!,
    );
    const authenticated = decodeSegment(
      (
        await signer.sign({
          method: "POST",
          url: "https://hub.example.test/api/auth/x",
          token: "t",
        })
      ).split(".")[1]!,
    );

    expect("ath" in mint).toBe(false);
    expect(typeof authenticated.ath).toBe("string");
  });

  it("emits a fresh jti per proof", async () => {
    const signer = createDpopProofSigner(fakeSigningKey(), context);
    const first = decodeSegment(
      (await signer.sign({ method: "GET", url: "https://hub.example.test/a" })).split(".")[1]!,
    );
    const second = decodeSegment(
      (await signer.sign({ method: "GET", url: "https://hub.example.test/a" })).split(".")[1]!,
    );

    expect(first.jti).not.toBe(second.jti);
  });

  it("never leaks the presented token into the proof", async () => {
    const signer = createDpopProofSigner(fakeSigningKey(), context);
    const proof = await signer.sign({
      method: "GET",
      url: "https://hub.example.test/api/nodes",
      token: "super-secret-token",
    });

    expect(proof).not.toContain("super-secret-token");
  });

  it("rejects a signing key carrying private JWK material", () => {
    expect(() =>
      createDpopProofSigner(
        {
          ...fakeSigningKey(),
          // Deliberately smuggles a private member past the static type: the
          // runtime guard, not the type system, is what must reject it.
          publicJwk: { kty: "EC", crv: "P-256", x: "eA", y: "eQ", d: "s3" } as DpopPublicJwk,
        },
        context,
      ),
    ).toThrow("DPoP proof JWK must not carry private key material.");
  });
});
