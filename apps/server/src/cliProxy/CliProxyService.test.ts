import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CliProxyHubConfig,
  type CliProxyHubId,
  type ProviderInstanceConfigMap,
} from "@ryco/contracts";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import {
  makeServerSettings,
  redactServerSettingsForClient,
  ServerSettingsService,
} from "../serverSettings.ts";
import { CliProxyService, CliProxyServiceLive } from "./CliProxyService.ts";

const HUB_URL = "http://hub.test:8317";
const MANAGEMENT_KEY = "mgmt-secret";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly cloudflareClientId: string | undefined;
  readonly cloudflareClientSecret: string | undefined;
  readonly body: unknown;
}

function requestBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const raw = (request.body as { readonly body?: Uint8Array }).body;
  return raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
}

const credentials = {
  files: [
    {
      auth_index: "claude0000000001",
      name: "claude-a.json",
      provider: "claude",
      email: "a@example.com",
      status: "active",
      success: 5,
      failed: 0,
      recent_requests: [],
      cooldowns: [],
    },
    {
      auth_index: "codex00000000001",
      name: "codex-b.json",
      provider: "codex",
      email: "b@example.com",
      status: "disabled",
      disabled: true,
    },
    { auth_index: "kimi000000000001", name: "kimi.json", provider: "kimi", status: "active" },
  ],
};

function upstream(url: string): { status_code: number; body: string } {
  if (url.endsWith("/api/oauth/usage")) {
    return {
      status_code: 200,
      body: JSON.stringify({
        five_hour: { utilization: 40, resets_at: "2026-10-11T15:00:00Z" },
        seven_day: { utilization: 10, resets_at: "2026-10-15T00:00:00Z" },
      }),
    };
  }
  if (url.endsWith("/api/oauth/profile")) {
    return { status_code: 200, body: JSON.stringify({ account: { has_claude_max: true } }) };
  }
  return { status_code: 404, body: "{}" };
}

/**
 * The real settings service over a temporary settings file: sensitive values are persisted
 * redacted and restored from this in-memory secret store, as on a running node.
 */
function liveSettingsLayer(secrets: Map<string, Uint8Array>) {
  const store: ServerSecretStoreShape = {
    get: (name) => Effect.sync(() => secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value.slice())),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  };
  return Layer.effect(ServerSettingsService, makeServerSettings).pipe(
    Layer.provide(Layer.succeed(ServerSecretStore, store)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-cli-proxy-test-" })),
    Layer.provide(NodeServices.layer),
  );
}

function makeHarness<E = never>(input: {
  readonly hubs?: Record<string, CliProxyHubConfig>;
  readonly providerInstances?: ProviderInstanceConfigMap;
  /** Replaces the in-memory test settings seeded from `hubs` and `providerInstances`. */
  readonly settings?: Layer.Layer<ServerSettingsService, E>;
  /** Answer v8 routes with 404 like a hub released before the v8 API. */
  readonly v0Only?: boolean;
  readonly rejectKey?: boolean;
  /** A failure the hub answers every management request with, while it returns one. */
  readonly managementReply?: () => { readonly status: number; readonly error: string } | undefined;
  readonly accessReply?: () => Response | undefined;
  /** Upstream calls through the passthrough never answer. */
  readonly hangApiCalls?: boolean;
}) {
  const requests: RecordedRequest[] = [];
  const json = (request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-cpa-version": "8.0.23" },
      }),
    );
  const client = HttpClient.make((request) => {
    const body = requestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers["authorization"],
      cloudflareClientId: request.headers["cf-access-client-id"],
      cloudflareClientSecret: request.headers["cf-access-client-secret"],
      body,
    });
    const accessReply = input.accessReply?.();
    if (accessReply) return Effect.succeed(HttpClientResponse.fromWeb(request, accessReply));
    const path = new URL(request.url).pathname;
    if (input.v0Only && path.startsWith("/v8/")) return Effect.succeed(json(request, 404, {}));
    if (input.rejectKey) {
      return Effect.succeed(json(request, 401, { error: "invalid management key" }));
    }
    const reply = input.managementReply?.();
    if (reply) return Effect.succeed(json(request, reply.status, { error: reply.error }));
    if (path.endsWith("/credentials") || path.endsWith("/auth-files")) {
      return Effect.succeed(json(request, 200, credentials));
    }
    if (path.endsWith("/observability/usage/api-keys") || path.endsWith("/api-key-usage")) {
      return Effect.succeed(
        json(request, 200, {
          claude: { "|sk-ant-api03-very-secret-0042": { success: 2, failed: 1 } },
        }),
      );
    }
    if (path.endsWith("/requests/api-call") || path.endsWith("/api-call")) {
      if (input.hangApiCalls) return Effect.never;
      return Effect.succeed(json(request, 200, upstream((body as { url: string }).url)));
    }
    return Effect.succeed(json(request, 404, {}));
  });
  const settings: Layer.Layer<ServerSettingsService, E> =
    input.settings ??
    ServerSettingsService.layerTest({
      cliProxyHubs: input.hubs ?? {},
      ...(input.providerInstances ? { providerInstances: input.providerInstances } : {}),
    });
  const layer = CliProxyServiceLive.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(settings),
  );
  return { requests, layer };
}

const hub = (overrides: Partial<CliProxyHubConfig> = {}): CliProxyHubConfig => ({
  url: HUB_URL,
  managementKey: MANAGEMENT_KEY,
  enabled: true,
  ...overrides,
});

it.effect("reads accounts, upstream quota and masked API-key counters", () => {
  const harness = makeHarness({ hubs: { local: hub({ label: "Home hub" }) } });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const { hubs } = yield* service.readHubs({});
    assert.strictEqual(hubs.length, 1);
    const snapshot = hubs[0]!;
    assert.strictEqual(snapshot.status, "ok");
    assert.strictEqual(snapshot.label, "Home hub");
    assert.strictEqual(snapshot.version, "8.0.23");

    const [claude, codex, kimi] = snapshot.accounts;
    assert.deepStrictEqual(claude?.quota.status, "ok");
    assert.deepStrictEqual(claude?.quota.planType, "max");
    assert.deepStrictEqual(
      claude?.quota.windows.map((window) => [window.id, window.usedPercent]),
      [
        ["five_hour", 40],
        ["seven_day", 10],
      ],
    );
    assert.deepStrictEqual(codex?.quota, { status: "skipped", windows: [] });
    assert.deepStrictEqual(kimi?.quota, { status: "unsupported", windows: [] });
    assert.deepStrictEqual(snapshot.apiKeys, [
      { provider: "claude", keyHint: "…0042", requests: { success: 2, failed: 1, recent: [] } },
    ]);
    assert.notInclude(JSON.stringify(snapshot), "very-secret");
    assert.notInclude(JSON.stringify(snapshot), MANAGEMENT_KEY);

    // Every request authenticates with the management key; upstream calls go through the
    // passthrough with the account's token placeholder, never a real token.
    for (const request of harness.requests) {
      assert.strictEqual(request.authorization, `Bearer ${MANAGEMENT_KEY}`);
      assert.isUndefined(request.cloudflareClientId);
      assert.isUndefined(request.cloudflareClientSecret);
    }
    const apiCalls = harness.requests.filter((request) => request.url.endsWith("/api-call"));
    assert.deepStrictEqual(
      apiCalls.map((request) => (request.body as { url: string }).url).toSorted(),
      ["https://api.anthropic.com/api/oauth/profile", "https://api.anthropic.com/api/oauth/usage"],
    );
    for (const request of apiCalls) {
      assert.deepInclude(request.body as object, { auth_index: "claude0000000001" });
      assert.strictEqual(
        (request.body as { header: Record<string, string> }).header.Authorization,
        "Bearer $TOKEN$",
      );
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "sends Access headers on all management routes, never in the upstream passthrough",
  () => {
    const harness = makeHarness({
      hubs: {
        local: hub({
          cloudflareAccessClientId: "token.access",
          cloudflareAccessClientSecret: "cf-secret",
        }),
      },
      v0Only: true,
    });
    return Effect.gen(function* () {
      const result = yield* (yield* CliProxyService).readHubs({});
      assert.strictEqual(result.hubs[0]?.status, "ok");
      assert.notInclude(JSON.stringify(result), "cf-secret");
      for (const request of harness.requests) {
        assert.strictEqual(request.cloudflareClientId, "token.access");
        assert.strictEqual(request.cloudflareClientSecret, "cf-secret");
        assert.notInclude(JSON.stringify(request.body ?? {}), "cf-secret");
        assert.notInclude(JSON.stringify(request.body ?? {}), "token.access");
      }
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "tests saved Access credentials even with a new management key and can disable them",
  () => {
    const secrets = new Map<string, Uint8Array>();
    const harness = makeHarness({ settings: liveSettingsLayer(secrets) });
    return Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const hubId = "local" as CliProxyHubId;
      yield* settings.updateSettings({
        cliProxyHubs: {
          [hubId]: hub({
            cloudflareAccessClientId: "token.access",
            cloudflareAccessClientSecret: "cf-secret",
          }),
        },
      });
      const service = yield* CliProxyService;
      yield* service.testHub({ url: HUB_URL, hubId, managementKey: "new-management-key" });
      assert.strictEqual(harness.requests[0]?.authorization, "Bearer new-management-key");
      assert.strictEqual(harness.requests[0]?.cloudflareClientSecret, "cf-secret");
      yield* service.testHub({
        url: HUB_URL,
        hubId,
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "",
      });
      assert.strictEqual(harness.requests[1]?.cloudflareClientSecret, "cf-secret");
      yield* service.testHub({
        url: HUB_URL,
        hubId,
        cloudflareAccessClientId: "",
        cloudflareAccessClientSecret: "",
      });
      assert.isUndefined(harness.requests[2]?.cloudflareClientSecret);

      for (const input of [
        {
          url: "https://other.example",
          hubId,
          managementKey: "new-key",
          cloudflareAccessClientId: "token.access",
        },
        { url: HUB_URL, hubId, cloudflareAccessClientId: "other.access" },
        { url: HUB_URL, managementKey: MANAGEMENT_KEY, cloudflareAccessClientId: "token.access" },
        {
          url: HUB_URL,
          managementKey: MANAGEMENT_KEY,
          cloudflareAccessClientId: "token.access",
          cloudflareAccessClientSecret: "bad\r\nheader",
        },
      ]) {
        yield* service.testHub(input).pipe(Effect.flip);
      }
      assert.strictEqual(harness.requests.length, 3, "incomplete or moved tokens are never sent");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "recovers from Cloudflare refusals on token rotation without pausing the management key",
  () => {
    let blocked = true;
    const harness = makeHarness({
      hubs: {
        local: hub({
          cloudflareAccessClientId: "token.access",
          cloudflareAccessClientSecret: "old-secret",
        }),
      },
      accessReply: () =>
        blocked
          ? new Response("<html>Cloudflare Access denied</html>", { status: 401 })
          : undefined,
    });
    return Effect.gen(function* () {
      const service = yield* CliProxyService;
      const first = yield* service.readHubs({});
      assert.include(first.hubs[0]?.error, "Cloudflare Access blocked");
      yield* service.readHubs({ refresh: true });
      assert.strictEqual(
        harness.requests.length,
        2,
        "Access refusals are not management-key rejections",
      );
      blocked = false;
      yield* (yield* ServerSettingsService).updateSettings({
        cliProxyHubs: {
          ["local" as CliProxyHubId]: hub({
            cloudflareAccessClientId: "token.access",
            cloudflareAccessClientSecret: "new-secret",
          }),
        },
      });
      const recovered = yield* service.readHubs({});
      assert.strictEqual(
        recovered.hubs[0]?.status,
        "ok",
        "rotation invalidates the cached failure",
      );
      assert.strictEqual(harness.requests[2]?.cloudflareClientSecret, "new-secret");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("does not retry a rejected management key after rotating only the Access token", () => {
  const harness = makeHarness({ rejectKey: true });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    for (const cloudflareAccessClientSecret of ["old-secret", "new-secret"]) {
      yield* service
        .testHub({
          url: HUB_URL,
          managementKey: MANAGEMENT_KEY,
          cloudflareAccessClientId: "token.access",
          cloudflareAccessClientSecret,
        })
        .pipe(Effect.flip);
    }
    assert.strictEqual(harness.requests.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("redacts an echoed Access secret from management failures", () => {
  const harness = makeHarness({
    managementReply: () => ({ status: 500, error: "echo cf-secret mgmt-secret" }),
  });
  return Effect.gen(function* () {
    const error = yield* (yield* CliProxyService)
      .testHub({
        url: HUB_URL,
        managementKey: MANAGEMENT_KEY,
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "cf-secret",
      })
      .pipe(Effect.flip);
    assert.notInclude(error.message, "cf-secret");
    assert.notInclude(error.message, MANAGEMENT_KEY);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("never forwards management or Access credentials through a real HTTP redirect", () =>
  Effect.gen(function* () {
    let forwarded = 0;
    const target = createServer((_request, response) => {
      forwarded += 1;
      response.end("{}");
    });
    const redirect = createServer((_request, response) => {
      const address = target.address();
      response.writeHead(302, {
        location: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
      });
      response.end();
    });
    for (const server of [target, redirect]) {
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        ),
        () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    }
    const address = redirect.address();
    assert.ok(address && typeof address === "object");
    const error = yield* (yield* CliProxyService)
      .testHub({
        url: `http://127.0.0.1:${address.port}`,
        managementKey: MANAGEMENT_KEY,
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "cf-secret",
      })
      .pipe(Effect.flip);
    assert.include(error.message, "does not forward credentials");
    assert.strictEqual(forwarded, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      CliProxyServiceLive.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ServerSettingsService.layerTest({})),
      ),
    ),
  ),
);

it.effect("reports the Claude instances routed through a hub from the current settings", () => {
  const claudeHub = ProviderInstanceId.make("claude_hub");
  const claudeDirect = ProviderInstanceId.make("claude_direct");
  const claudeAgent = ProviderDriverKind.make("claudeAgent");
  const hubBaseUrl = "http://localhost:8317/v1";
  const harness = makeHarness({
    hubs: { local: hub({ url: "http://127.0.0.1:8317" }) },
    providerInstances: {
      [claudeHub]: {
        driver: claudeAgent,
        environment: [{ name: "ANTHROPIC_BASE_URL", value: hubBaseUrl, sensitive: true }],
      },
      [claudeDirect]: { driver: claudeAgent },
    },
  });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const settings = yield* ServerSettingsService;
    const first = yield* service.readHubs({});
    assert.deepStrictEqual(first.hubs[0]?.routedInstanceIds, [claudeHub]);

    yield* settings.updateSettings({
      providerInstances: {
        [claudeDirect]: {
          driver: claudeAgent,
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "http://[::1]:8317", sensitive: false },
          ],
        },
      },
    });
    const requests = harness.requests.length;
    const second = yield* service.readHubs({});
    assert.strictEqual(harness.requests.length, requests, "the hub snapshot is still cached");
    assert.deepStrictEqual(second.hubs[0]?.routedInstanceIds, [claudeDirect]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("routes an instance by a sensitive base URL restored from the secret store", () => {
  const claudeHub = ProviderInstanceId.make("claude_hub");
  const hubBaseUrl = "http://localhost:8317/v1";
  const secrets = new Map<string, Uint8Array>();
  const harness = makeHarness({ settings: liveSettingsLayer(secrets) });
  return Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({
      cliProxyHubs: { ["local" as CliProxyHubId]: hub({ url: "http://127.0.0.1:8317" }) },
      providerInstances: {
        [claudeHub]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "ANTHROPIC_BASE_URL", value: hubBaseUrl, sensitive: true }],
        },
      },
    });
    const decoder = new TextDecoder();
    assert.ok(
      [...secrets.values()].some((value) => decoder.decode(value) === hubBaseUrl),
      "the base URL is persisted as a secret",
    );

    const { hubs } = yield* (yield* CliProxyService).readHubs({});
    assert.deepStrictEqual(hubs[0]?.routedInstanceIds, [claudeHub]);
    // Clients never see the base URL, only the routing it implies.
    const visible = redactServerSettingsForClient(yield* settings.getSettings);
    assert.strictEqual(visible.providerInstances[claudeHub]?.environment?.[0]?.value, "");
    assert.notInclude(JSON.stringify(hubs), hubBaseUrl);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("falls back to v0 management paths and remembers the working API", () => {
  const harness = makeHarness({ hubs: { local: hub() }, v0Only: true });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const first = yield* service.readHubs({});
    assert.strictEqual(first.hubs[0]?.status, "ok");
    const v8Requests = harness.requests.filter((request) => request.url.includes("/v8/"));
    assert.strictEqual(v8Requests.length, 1, "only the first request probes v8");
    assert.ok(
      harness.requests.some((request) => request.url.endsWith("/v0/management/auth-files")),
    );
    assert.ok(harness.requests.some((request) => request.url.endsWith("/v0/management/api-call")));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("serves cached snapshots and keeps a floor under forced quota refreshes", () => {
  const harness = makeHarness({ hubs: { local: hub() } });
  const quotaReads = () =>
    harness.requests.filter(
      (request) =>
        request.url.endsWith("/api-call") &&
        (request.body as { url: string }).url.endsWith("/usage"),
    ).length;
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    yield* service.readHubs({});
    const afterFirst = harness.requests.length;
    yield* service.readHubs({});
    assert.strictEqual(harness.requests.length, afterFirst, "a fresh snapshot is reused");

    yield* service.readHubs({ refresh: true });
    assert.ok(harness.requests.length > afterFirst, "a refresh re-lists the accounts");
    assert.strictEqual(quotaReads(), 1, "quota is not re-read inside the refresh floor");

    yield* TestClock.adjust("61 seconds");
    yield* service.readHubs({ refresh: true });
    assert.strictEqual(quotaReads(), 2);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("lets a reader that waited for a slow read reuse it", () => {
  const harness = makeHarness({ hubs: { local: hub() }, hangApiCalls: true });
  const count = (suffix: string) =>
    harness.requests.filter((request) => request.url.endsWith(suffix)).length;
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const first = yield* Effect.forkChild(service.readHubs({}));
    yield* TestClock.adjust("10 seconds");
    const second = yield* Effect.forkChild(service.readHubs({}));
    // The upstream calls time out after 45 seconds; the waiting reader then takes the lock.
    yield* TestClock.adjust("40 seconds");
    const read = yield* Fiber.join(first);
    const reused = yield* Fiber.join(second);
    assert.strictEqual(count("/credentials"), 1, "the waiting reader does not list again");
    assert.deepStrictEqual(reused, read);
    assert.strictEqual(read.hubs[0]?.accounts[0]?.quota.status, "failed");

    // The failed quota holds the refresh floor from when its read ended.
    const apiCalls = count("/api-call");
    yield* TestClock.adjust("30 seconds");
    yield* service.readHubs({ refresh: true });
    assert.strictEqual(count("/credentials"), 2);
    assert.strictEqual(count("/api-call"), apiCalls);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("never resends a rejected management key, on refresh or in a test", () => {
  const harness = makeHarness({ hubs: { local: hub() }, rejectKey: true });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const first = yield* service.readHubs({});
    assert.strictEqual(first.hubs[0]?.status, "error");
    assert.strictEqual(first.hubs[0]?.error, "The hub rejected the management key.");
    assert.strictEqual(harness.requests.length, 1);

    // The hub keeps counting the rejection toward its IP ban for up to three hours.
    yield* TestClock.adjust("2 hours");
    const refreshed = yield* service.readHubs({ refresh: true });
    assert.include(refreshed.hubs[0]?.error, "will not send it again for about 60 minutes");
    const tested = yield* service
      .testHub({ url: HUB_URL, hubId: "local" as CliProxyHubId })
      .pipe(Effect.flip);
    assert.include(tested.message, "will not send it again");
    assert.strictEqual(harness.requests.length, 1);

    // Once the hub has forgotten it, the key is tried once more.
    yield* TestClock.adjust("1 hour");
    yield* service.readHubs({});
    assert.strictEqual(harness.requests.length, 2);
    yield* service.readHubs({ refresh: true });
    assert.strictEqual(harness.requests.length, 2);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stops sending new keys before the hub would ban this machine", () => {
  const harness = makeHarness({ rejectKey: true });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    for (const managementKey of ["one", "two", "three", "four"]) {
      const rejected = yield* service.testHub({ url: HUB_URL, managementKey }).pipe(Effect.flip);
      assert.strictEqual(rejected.message, "The hub rejected the management key.");
    }
    // The hub bans at five; a loopback alias or another path reaches the same counter.
    const paused = yield* service
      .testHub({ url: `${HUB_URL}/v0/management`, managementKey: "five" })
      .pipe(Effect.flip);
    assert.include(paused.message, "rejected 4 management keys recently");
    assert.strictEqual(harness.requests.length, 4);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retries refusals the hub does not count and waits out a ban", () => {
  let reply: { readonly status: number; readonly error: string } | undefined = {
    status: 403,
    error: "remote management disabled",
  };
  const harness = makeHarness({ hubs: { local: hub() }, managementReply: () => reply });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const disabled = yield* service.readHubs({});
    assert.include(disabled.hubs[0]?.error, "Remote management is disabled");
    yield* service.readHubs({ refresh: true });
    assert.strictEqual(harness.requests.length, 2, "an uncounted refusal does not pause reads");

    reply = { status: 403, error: "IP banned due to too many failed attempts. Try again in 30m0s" };
    yield* service.readHubs({ refresh: true });
    assert.strictEqual(harness.requests.length, 3);
    yield* TestClock.adjust("10 minutes");
    const banned = yield* service.readHubs({ refresh: true });
    assert.include(banned.hubs[0]?.error, "blocked this machine's IP address");
    assert.strictEqual(harness.requests.length, 3);

    reply = undefined;
    yield* TestClock.adjust("21 minutes");
    const recovered = yield* service.readHubs({ refresh: true });
    assert.strictEqual(recovered.hubs[0]?.status, "ok");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports unusable hubs without contacting them and skips disabled ones", () => {
  const harness = makeHarness({
    hubs: {
      nokey: hub({ managementKey: "" }),
      badurl: hub({ url: "ftp://hub.test" }),
      incomplete: hub({ cloudflareAccessClientId: "token.access" }),
      badheader: hub({
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "bad\nheader",
      }),
      off: hub({ enabled: false }),
    },
  });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const { hubs } = yield* service.readHubs({});
    assert.deepStrictEqual(
      hubs.map((snapshot) => [snapshot.hubId, snapshot.status]),
      [
        ["nokey", "error"],
        ["badurl", "error"],
        ["incomplete", "error"],
        ["badheader", "error"],
      ],
    );
    assert.strictEqual(harness.requests.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("tests a hub with the stored key when editing a saved hub", () => {
  const harness = makeHarness({ hubs: { local: hub() } });
  return Effect.gen(function* () {
    const service = yield* CliProxyService;
    const result = yield* service.testHub({
      url: `${HUB_URL}/v0/management`,
      hubId: "local" as CliProxyHubId,
    });
    assert.deepStrictEqual(result, { version: "8.0.23", accountCount: 3 });
    assert.strictEqual(harness.requests[0]?.url, `${HUB_URL}/v8/management/credentials`);

    const missingKey = yield* service
      .testHub({ url: HUB_URL, managementKey: "  " })
      .pipe(Effect.flip);
    assert.strictEqual(missingKey.message, "Enter the hub's management key.");

    // The saved key is never sent to an address it was not entered for.
    const requestsBefore = harness.requests.length;
    const moved = yield* service
      .testHub({ url: "https://other.example:8317", hubId: "local" as CliProxyHubId })
      .pipe(Effect.flip);
    assert.strictEqual(
      moved.message,
      "Enter the management key again to test a different hub address.",
    );
    assert.strictEqual(harness.requests.length, requestsBefore);
  }).pipe(Effect.provide(harness.layer));
});
