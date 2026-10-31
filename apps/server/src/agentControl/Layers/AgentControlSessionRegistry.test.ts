import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { assert, it, vi } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option, Redacted, Scope } from "effect";

import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlSessionRegistryLive } from "./AgentControlSessionRegistry.ts";
import { AGENT_CONTROL_BOOTSTRAP_TTL_MS } from "./AgentControlSessionRegistry.ts";
import {
  AgentControlSessionRegistry,
  type AgentControlIssuedLease,
} from "../Services/AgentControlSessionRegistry.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const codexInstance = ProviderInstanceId.make("codex");
const runtime1 = RuntimeSessionId.make("runtime-1");
const runtime2 = RuntimeSessionId.make("runtime-2");
const READ = [AGENT_CONTROL_CAPABILITIES.read];

const ENDPOINT = { url: "http://127.0.0.1:45999/mcp" };

const makeLayer = (enabled: boolean) =>
  AgentControlSessionRegistryLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(
      ServerSettingsService.layerTest(enabled ? { agentControl: { enabled: true } } : {}),
    ),
  );

const issue = (input?: {
  readonly threadId?: ThreadId;
  readonly runtimeSessionId?: RuntimeSessionId;
}) =>
  Effect.gen(function* () {
    const registry = yield* AgentControlSessionRegistry;
    const lease = yield* registry.issueLease({
      threadId: input?.threadId ?? threadA,
      providerInstanceId: codexInstance,
      runtimeSessionId: input?.runtimeSessionId ?? runtime1,
      capabilities: READ,
      injectionMode: "codex-http",
    });
    assert.isTrue(Option.isSome(lease));
    return (lease as Option.Some<AgentControlIssuedLease>).value;
  });

const bearer = (lease: AgentControlIssuedLease) => `Bearer ${Redacted.value(lease.credential)}`;

const enabledLayer = it.layer(makeLayer(true));
const disabledLayer = it.layer(makeLayer(false));

disabledLayer("AgentControlSessionRegistry (feature disabled)", (it) => {
  it.effect("refuses to issue leases while the feature gate is off", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const lease = yield* registry.issueLease({
        threadId: threadA,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: READ,
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isNone(lease));
      assert.strictEqual(yield* registry.activeSessionCount, 0);
    }),
  );
});

enabledLayer("AgentControlSessionRegistry", (it) => {
  it.effect("exchanges a stdio bootstrap once and rejects reuse", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const issued = yield* registry.issueStdioBootstrap({
        threadId: threadA,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        runtimeSessionId: runtime1,
        capabilities: READ,
        injectionMode: "acp-stdio-proxy",
      });
      assert.isTrue(Option.isSome(issued));
      if (Option.isNone(issued)) return;
      const token = Redacted.value(issued.value.bootstrapToken);
      const lease = yield* registry.exchangeStdioBootstrap(token);
      assert.strictEqual(lease.sessionId, issued.value.sessionId);
      assert.strictEqual(
        (yield* registry.authenticate(`Bearer ${Redacted.value(lease.credential)}`)).threadId,
        threadA,
      );
      const reused = yield* Effect.flip(registry.exchangeStdioBootstrap(token));
      assert.strictEqual(reused.reason, "unknown");
    }),
  );

  it.effect(
    "expires a bootstrap, revokes its matching lease, and leaves other threads intact",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
          const registry = yield* AgentControlSessionRegistry;
          yield* registry.publishEndpoint(ENDPOINT);
          const expiring = yield* registry.issueStdioBootstrap({
            threadId: threadA,
            providerInstanceId: ProviderInstanceId.make("cursor"),
            runtimeSessionId: runtime1,
            capabilities: READ,
            injectionMode: "acp-stdio-proxy",
          });
          assert.isTrue(Option.isSome(expiring));
          if (Option.isNone(expiring)) return;
          const other = yield* registry.issueLease({
            threadId: threadB,
            providerInstanceId: codexInstance,
            runtimeSessionId: runtime2,
            capabilities: READ,
            injectionMode: "codex-http",
          });
          assert.isTrue(Option.isSome(other));
          if (Option.isNone(other)) return;
          vi.setSystemTime(new Date(Date.now() + AGENT_CONTROL_BOOTSTRAP_TTL_MS));
          const expired = yield* Effect.flip(
            registry.exchangeStdioBootstrap(Redacted.value(expiring.value.bootstrapToken)),
          );
          assert.strictEqual(expired.reason, "expired");
          const otherSession = yield* registry.authenticate(
            `Bearer ${Redacted.value(other.value.credential)}`,
          );
          assert.strictEqual(otherSession.threadId, threadB);
        } finally {
          vi.useRealTimers();
        }
      }),
  );

  it.effect("refuses to issue leases without a healthy listener endpoint", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.clearEndpoint;
      const lease = yield* registry.issueLease({
        threadId: threadA,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: READ,
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isNone(lease));
    }),
  );

  it.effect("issues a lease bound to thread, instance, epoch, and capabilities", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const lease = yield* issue();
      assert.strictEqual(lease.endpointUrl, ENDPOINT.url);

      const session = yield* registry.authenticate(bearer(lease));
      assert.strictEqual(session.threadId, threadA);
      assert.strictEqual(session.providerInstanceId, codexInstance);
      assert.strictEqual(session.runtimeSessionId, runtime1);
      assert.deepStrictEqual([...session.grantedCapabilities], READ);
      yield* registry.revokeAll("runtime-teardown");
    }),
  );

  it.effect("rejects missing, malformed, hub-style, and never-issued credentials", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      yield* issue();

      const missing = yield* Effect.flip(registry.authenticate(undefined));
      assert.strictEqual(missing.reason, "missing");

      const empty = yield* Effect.flip(registry.authenticate(""));
      assert.strictEqual(empty.reason, "missing");

      // Hub/browser-session-shaped material is structurally malformed here:
      // the endpoint accepts exactly one credential format.
      for (const header of [
        "Bearer session-token-from-the-public-server",
        "Bearer ryco_pairing_0123456789abcdef",
        `Basic ${Buffer.from("user:pass").toString("base64")}`,
        "Bearer rycoac_too-short",
        "rycoac_missing-bearer-prefix",
      ]) {
        const malformed = yield* Effect.flip(registry.authenticate(header));
        assert.strictEqual(malformed.reason, "malformed", header);
      }

      // Correct shape, never issued (e.g. minted by a stale pre-restart
      // process): indistinguishable from revoked.
      const unknown = yield* Effect.flip(registry.authenticate(`Bearer rycoac_${"A".repeat(43)}`));
      assert.strictEqual(unknown.reason, "unknown");
      yield* registry.revokeAll("runtime-teardown");
    }),
  );

  it.effect("revokes by exact runtime epoch and aborts in-flight requests", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const lease = yield* issue();

      const abort = vi.fn();
      yield* registry.registerInFlight(lease.sessionId, { abort });

      // A different epoch of the same thread does not revoke this lease.
      yield* registry.revokeLeases({
        threadId: threadA,
        runtimeSessionId: runtime2,
        reason: "runtime-replaced",
      });
      assert.strictEqual(abort.mock.calls.length, 0);
      yield* registry.authenticate(bearer(lease));

      // A different thread does not revoke it either.
      yield* registry.revokeLeases({ threadId: threadB, reason: "runtime-teardown" });
      yield* registry.authenticate(bearer(lease));

      // The exact epoch does — synchronously, aborting in-flight requests.
      yield* registry.revokeLeases({
        threadId: threadA,
        runtimeSessionId: runtime1,
        reason: "runtime-teardown",
      });
      assert.strictEqual(abort.mock.calls.length, 1);
      const revoked = yield* Effect.flip(registry.authenticate(bearer(lease)));
      assert.strictEqual(revoked.reason, "unknown");
      assert.strictEqual(yield* registry.activeSessionCount, 0);
    }),
  );

  it.effect("revokeLease by unique id never touches a successor with a reused epoch", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      // Recovery can legitimately reuse the exact same (thread, epoch)
      // pair for a successor runtime. A stale teardown that revokes by the
      // first lease's unique id must be a no-op against the successor.
      const first = yield* issue({ runtimeSessionId: runtime1 });
      const second = yield* issue({ runtimeSessionId: runtime1 });

      yield* registry.revokeLease({ sessionId: first.sessionId, reason: "runtime-teardown" });

      const survivor = yield* registry.authenticate(bearer(second));
      assert.strictEqual(survivor.sessionId, second.sessionId);
      assert.strictEqual(yield* registry.activeSessionCount, 1);

      // Revoking the live lease by its own id works and is idempotent.
      yield* registry.revokeLease({ sessionId: second.sessionId, reason: "runtime-teardown" });
      yield* registry.revokeLease({ sessionId: second.sessionId, reason: "runtime-teardown" });
      const gone = yield* Effect.flip(registry.authenticate(bearer(second)));
      assert.strictEqual(gone.reason, "unknown");
    }),
  );

  it.effect("re-issuing for a thread supersedes the prior runtime's lease", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const first = yield* issue({ runtimeSessionId: runtime1 });
      const second = yield* issue({ runtimeSessionId: runtime2 });

      const stale = yield* Effect.flip(registry.authenticate(bearer(first)));
      assert.strictEqual(stale.reason, "unknown");
      const fresh = yield* registry.authenticate(bearer(second));
      assert.strictEqual(fresh.runtimeSessionId, runtime2);
      assert.strictEqual(yield* registry.activeSessionCount, 1);
      yield* registry.revokeAll("runtime-teardown");
    }),
  );

  it.effect("binds exact-turn authority and retires it synchronously", () =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const lease = yield* issue();
      const turn1 = TurnId.make("turn-1");
      const turn2 = TurnId.make("turn-2");

      const unknownSession = yield* Effect.flip(
        registry.bindTurnAuthority({ sessionId: "no-such-session", turnId: turn1 }),
      );
      assert.strictEqual(unknownSession.reason, "session-unknown");

      const authority = yield* registry.bindTurnAuthority({
        sessionId: lease.sessionId,
        turnId: turn1,
      });
      assert.strictEqual(authority.threadId, threadA);
      assert.strictEqual(authority.turnId, turn1);

      const turnScopedAbort = vi.fn();
      const sessionScopedAbort = vi.fn();
      yield* registry.registerInFlight(lease.sessionId, {
        abort: turnScopedAbort,
        turnId: turn1,
      });
      yield* registry.registerInFlight(lease.sessionId, { abort: sessionScopedAbort });

      // Binding a replacement turn synchronously retires the old turn and
      // aborts only its write requests; no request can inherit authority.
      yield* registry.bindTurnAuthority({ sessionId: lease.sessionId, turnId: turn2 });
      assert.strictEqual(turnScopedAbort.mock.calls.length, 1);
      assert.strictEqual(sessionScopedAbort.mock.calls.length, 0);
      assert.strictEqual(
        Option.getOrThrow(yield* registry.getTurnAuthority(lease.sessionId)).turnId,
        turn2,
      );

      // Restore turn 1 to exercise exact retirement below.
      yield* registry.bindTurnAuthority({ sessionId: lease.sessionId, turnId: turn1 });

      // Retiring a different turn is a no-op.
      yield* registry.retireTurnAuthority({ threadId: threadA, turnId: turn2 });
      assert.isTrue(Option.isSome(yield* registry.getTurnAuthority(lease.sessionId)));

      // Retiring the bound turn clears authority and aborts only requests
      // bound to that turn; the session and its read requests survive.
      yield* registry.retireTurnAuthority({ threadId: threadA, turnId: turn1 });
      assert.isTrue(Option.isNone(yield* registry.getTurnAuthority(lease.sessionId)));
      assert.strictEqual(turnScopedAbort.mock.calls.length, 1);
      assert.strictEqual(sessionScopedAbort.mock.calls.length, 0);
      yield* registry.authenticate(bearer(lease));

      // A later turn cannot inherit the retired authority implicitly.
      assert.isTrue(Option.isNone(yield* registry.getTurnAuthority(lease.sessionId)));
      yield* registry.revokeAll("runtime-teardown");
    }),
  );
});

it.effect("server shutdown (layer scope close) revokes every credential", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const context = yield* Layer.build(makeLayer(true)).pipe(Scope.provide(scope));
    const registry = Context.get(context, AgentControlSessionRegistry);

    yield* registry.publishEndpoint(ENDPOINT);
    const lease = yield* registry.issueLease({
      threadId: threadA,
      providerInstanceId: codexInstance,
      runtimeSessionId: runtime1,
      capabilities: READ,
      injectionMode: "codex-http",
    });
    assert.isTrue(Option.isSome(lease));
    const credential = `Bearer ${Redacted.value(
      (lease as Option.Some<AgentControlIssuedLease>).value.credential,
    )}`;
    yield* registry.authenticate(credential);

    yield* Scope.close(scope, Exit.void);

    const afterShutdown = yield* Effect.flip(registry.authenticate(credential));
    assert.strictEqual(afterShutdown.reason, "unknown");
    assert.strictEqual(yield* registry.activeSessionCount, 0);
  }),
);

const depthLimitedLayer = it.layer(
  AgentControlSessionRegistryLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        agentControl: { enabled: true, delegation: { maxDepth: 1 } },
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

depthLimitedLayer("AgentControlSessionRegistry (delegation depth limit)", (it) => {
  const AT = "2026-10-31T00:00:00.000Z";
  const insertThread = (threadId: string, parent: string | null) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at,
          lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship)
        VALUES (${threadId}, 'project', ${threadId}, '{}', 'full-access', 'default', ${AT}, ${AT},
          ${parent}, ${parent}, ${parent === null ? null : "delegated"})`;
    });
  const grantedFor = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const registry = yield* AgentControlSessionRegistry;
      yield* registry.publishEndpoint(ENDPOINT);
      const lease = yield* registry.issueLease({
        threadId,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: [AGENT_CONTROL_CAPABILITIES.read, AGENT_CONTROL_CAPABILITIES.createThreads],
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isSome(lease));
      const session = yield* registry.authenticate(
        bearer((lease as Option.Some<AgentControlIssuedLease>).value),
      );
      return session.grantedCapabilities;
    });

  it.effect("keeps delegation for a chat but withholds it from a task at the last level", () =>
    Effect.gen(function* () {
      yield* insertThread("chat", null);
      yield* insertThread("task", "chat");
      assert.include(
        yield* grantedFor(ThreadId.make("chat")),
        AGENT_CONTROL_CAPABILITIES.createThreads,
      );
      const task = yield* grantedFor(ThreadId.make("task"));
      assert.notInclude(task, AGENT_CONTROL_CAPABILITIES.createThreads);
      assert.include(task, AGENT_CONTROL_CAPABILITIES.read);
      // Fails closed: a thread whose lineage cannot be read gets no delegation tools either.
      assert.notInclude(
        yield* grantedFor(ThreadId.make("unprojected")),
        AGENT_CONTROL_CAPABILITIES.createThreads,
      );
    }),
  );
});
