import { retireComputerTurn, bindComputerTurn } from "../../computer/computerTurnLifecycle.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Effect, Layer, Option, Redacted } from "effect";

import {
  AgentControlBootstrapError,
  AgentControlMcpAuthError,
  AgentControlTurnAuthorityError,
} from "../Errors.ts";
import {
  AgentControlSessionRegistry,
  type AgentControlInFlightRequest,
  type AgentControlMcpEndpoint,
  type AgentControlSessionRecord,
  type AgentControlSessionRegistryShape,
  type AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";

/**
 * Internal provider-session bearer format: a recognizable prefix plus 32
 * random bytes, base64url. The prefix lets the authenticator reject
 * foreign credential shapes (hub/browser session tokens, cookies, DPoP
 * proofs) as `malformed` before any lookup happens.
 */
const CREDENTIAL_PREFIX = "rycoac_";
const CREDENTIAL_PATTERN = /^rycoac_[A-Za-z0-9_-]{43}$/;
const BOOTSTRAP_PREFIX = "rycoacb_";
const BOOTSTRAP_PATTERN = /^rycoacb_[A-Za-z0-9_-]{43}$/;
export const AGENT_CONTROL_BOOTSTRAP_TTL_MS = 30_000;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/;

const digestCredential = (credential: string): string =>
  createHash("sha256").update(credential, "utf8").digest("hex");

interface RegistrySession {
  readonly digest: string;
  readonly record: AgentControlSessionRecord;
  readonly inFlight: Set<AgentControlInFlightRequest>;
  turnAuthority: AgentControlTurnAuthority | null;
}

interface RegistryBootstrap {
  readonly sessionId: string;
  readonly endpointUrl: string;
  readonly credential: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

const abortRequests = (
  session: RegistrySession,
  predicate: (request: AgentControlInFlightRequest) => boolean,
): void => {
  // Snapshot first: abort callbacks may unregister entries re-entrantly.
  const requests = Array.from(session.inFlight);
  for (const request of requests) {
    if (!predicate(request)) continue;
    session.inFlight.delete(request);
    try {
      request.abort();
    } catch {
      // An abort callback must never take the registry down with it.
    }
  }
};

const makeAgentControlSessionRegistry = Effect.gen(function* () {
  const policy = yield* AgentControlPolicy;

  // All state is per-process memory. A server restart therefore revokes
  // every previously issued credential wholesale, and a stale provider
  // process holding an old bearer cannot regain authority: the digest map
  // is empty and the listener port is freshly ephemeral.
  const sessionsByDigest = new Map<string, RegistrySession>();
  const sessionsById = new Map<string, RegistrySession>();
  const digestsByThread = new Map<string, Set<string>>();
  const bootstrapsByDigest = new Map<string, RegistryBootstrap>();
  let endpoint: AgentControlMcpEndpoint | null = null;

  const dropSession = (session: RegistrySession): void => {
    if (session.turnAuthority)
      retireComputerTurn(session.record.threadId, session.turnAuthority.turnId);
    abortRequests(session, () => true);
    session.turnAuthority = null;
    sessionsByDigest.delete(session.digest);
    sessionsById.delete(session.record.sessionId);
    for (const [digest, bootstrap] of bootstrapsByDigest) {
      if (bootstrap.sessionId === session.record.sessionId) bootstrapsByDigest.delete(digest);
    }
    const threadDigests = digestsByThread.get(session.record.threadId);
    if (threadDigests) {
      threadDigests.delete(session.digest);
      if (threadDigests.size === 0) digestsByThread.delete(session.record.threadId);
    }
  };

  const revokeMatching = (predicate: (session: RegistrySession) => boolean): void => {
    // Snapshot first: dropSession mutates the map during iteration.
    const sessions = Array.from(sessionsByDigest.values());
    for (const session of sessions) {
      if (predicate(session)) dropSession(session);
    }
  };

  const issueLease: AgentControlSessionRegistryShape["issueLease"] = (input) =>
    policy.isEnabled.pipe(
      Effect.map((enabled) => {
        if (!enabled || endpoint === null) return Option.none();

        // One runtime per thread: a new lease supersedes any prior epoch.
        // Snapshot first: dropSession mutates the digest set during iteration.
        const priorDigests = Array.from(digestsByThread.get(input.threadId) ?? []);
        for (const digest of priorDigests) {
          const prior = sessionsByDigest.get(digest);
          if (prior) dropSession(prior);
        }

        const credential = `${CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
        const digest = digestCredential(credential);
        const session: RegistrySession = {
          digest,
          record: {
            sessionId: randomUUID(),
            threadId: input.threadId,
            providerInstanceId: input.providerInstanceId,
            runtimeSessionId: input.runtimeSessionId,
            grantedCapabilities: [...input.capabilities],
            issuedAt: new Date().toISOString(),
            injectionMode: input.injectionMode,
          },
          inFlight: new Set(),
          turnAuthority: null,
        };
        sessionsByDigest.set(digest, session);
        sessionsById.set(session.record.sessionId, session);
        const threadDigests = digestsByThread.get(input.threadId) ?? new Set<string>();
        threadDigests.add(digest);
        digestsByThread.set(input.threadId, threadDigests);

        return Option.some({
          sessionId: session.record.sessionId,
          endpointUrl: endpoint.url,
          credential: Redacted.make(credential),
        });
      }),
    );

  const issueStdioBootstrap: AgentControlSessionRegistryShape["issueStdioBootstrap"] = (input) =>
    issueLease(input).pipe(
      Effect.map(
        Option.map((lease) => {
          const token = `${BOOTSTRAP_PREFIX}${randomBytes(32).toString("base64url")}`;
          const expiresAt = Date.now() + AGENT_CONTROL_BOOTSTRAP_TTL_MS;
          bootstrapsByDigest.set(digestCredential(token), {
            sessionId: lease.sessionId,
            endpointUrl: lease.endpointUrl,
            credential: lease.credential,
            expiresAt,
          });
          return {
            sessionId: lease.sessionId,
            endpointUrl: lease.endpointUrl,
            bootstrapToken: Redacted.make(token),
            expiresAt,
          };
        }),
      ),
    );

  const exchangeStdioBootstrap: AgentControlSessionRegistryShape["exchangeStdioBootstrap"] = (
    bootstrapToken,
  ) =>
    Effect.suspend(() => {
      if (!BOOTSTRAP_PATTERN.test(bootstrapToken)) {
        return Effect.fail(new AgentControlBootstrapError({ reason: "malformed" }));
      }
      const digest = digestCredential(bootstrapToken);
      const bootstrap = bootstrapsByDigest.get(digest);
      // Delete before any check or return: every well-formed lookup is one-shot,
      // including an expired token raced by two proxy processes.
      bootstrapsByDigest.delete(digest);
      if (bootstrap === undefined || !sessionsById.has(bootstrap.sessionId)) {
        return Effect.fail(new AgentControlBootstrapError({ reason: "unknown" }));
      }
      if (Date.now() >= bootstrap.expiresAt) {
        const session = sessionsById.get(bootstrap.sessionId);
        if (session) dropSession(session);
        return Effect.fail(new AgentControlBootstrapError({ reason: "expired" }));
      }
      return Effect.succeed({
        sessionId: bootstrap.sessionId,
        endpointUrl: bootstrap.endpointUrl,
        credential: bootstrap.credential,
      });
    });

  const authenticate: AgentControlSessionRegistryShape["authenticate"] = (authorizationHeader) =>
    Effect.suspend(() => {
      if (authorizationHeader === undefined || authorizationHeader.length === 0) {
        return Effect.fail(new AgentControlMcpAuthError({ reason: "missing" }));
      }
      const bearer = BEARER_PATTERN.exec(authorizationHeader);
      const credential = bearer?.[1];
      if (credential === undefined || !CREDENTIAL_PATTERN.test(credential)) {
        return Effect.fail(new AgentControlMcpAuthError({ reason: "malformed" }));
      }
      const session = sessionsByDigest.get(digestCredential(credential));
      if (session === undefined) {
        return Effect.fail(new AgentControlMcpAuthError({ reason: "unknown" }));
      }
      return Effect.succeed(session.record);
    });

  const revokeLease: AgentControlSessionRegistryShape["revokeLease"] = (input) =>
    Effect.sync(() => {
      const session = sessionsById.get(input.sessionId);
      if (session !== undefined) dropSession(session);
    });

  const revokeLeases: AgentControlSessionRegistryShape["revokeLeases"] = (input) =>
    Effect.sync(() => {
      revokeMatching(
        (session) =>
          session.record.threadId === input.threadId &&
          (input.runtimeSessionId === undefined ||
            session.record.runtimeSessionId === input.runtimeSessionId),
      );
    });

  const revokeAll: AgentControlSessionRegistryShape["revokeAll"] = () =>
    Effect.sync(() => {
      revokeMatching(() => true);
    });

  const registerInFlight: AgentControlSessionRegistryShape["registerInFlight"] = (
    sessionId,
    request,
  ) =>
    Effect.suspend(() => {
      const session = sessionsById.get(sessionId);
      if (session === undefined) {
        return Effect.fail(new AgentControlTurnAuthorityError({ reason: "session-unknown" }));
      }
      if (request.turnId !== undefined) {
        if (session.turnAuthority === null) {
          return Effect.fail(new AgentControlTurnAuthorityError({ reason: "authority-retired" }));
        }
        if (session.turnAuthority.turnId !== request.turnId) {
          return Effect.fail(new AgentControlTurnAuthorityError({ reason: "turn-mismatch" }));
        }
      }
      session.inFlight.add(request);
      return Effect.succeed(() => {
        session.inFlight.delete(request);
      });
    });

  const bindTurnAuthority: AgentControlSessionRegistryShape["bindTurnAuthority"] = (input) =>
    Effect.suspend(() => {
      const session = sessionsById.get(input.sessionId);
      if (session === undefined) {
        return Effect.fail(new AgentControlTurnAuthorityError({ reason: "session-unknown" }));
      }
      const authority: AgentControlTurnAuthority = {
        sessionId: session.record.sessionId,
        threadId: session.record.threadId,
        turnId: input.turnId,
        boundAt: new Date().toISOString(),
      };
      const previous = session.turnAuthority;
      session.turnAuthority = authority;
      bindComputerTurn(session.record.threadId, input.turnId);
      if (previous !== null && previous.turnId !== authority.turnId) {
        retireComputerTurn(session.record.threadId, previous.turnId);
        abortRequests(session, (request) => request.turnId === previous.turnId);
      }
      return Effect.succeed(authority);
    });

  const retireTurnAuthority: AgentControlSessionRegistryShape["retireTurnAuthority"] = (input) =>
    Effect.sync(() => {
      for (const session of sessionsByDigest.values()) {
        if (session.record.threadId !== input.threadId) continue;
        const authority = session.turnAuthority;
        if (authority === null) continue;
        if (input.turnId !== undefined && authority.turnId !== input.turnId) continue;
        session.turnAuthority = null;
        retireComputerTurn(session.record.threadId, authority.turnId);
        abortRequests(session, (request) => request.turnId === authority.turnId);
      }
    });

  const getTurnAuthority: AgentControlSessionRegistryShape["getTurnAuthority"] = (sessionId) =>
    Effect.sync(() => Option.fromNullishOr(sessionsById.get(sessionId)?.turnAuthority));

  const publishEndpoint: AgentControlSessionRegistryShape["publishEndpoint"] = (next) =>
    Effect.sync(() => {
      endpoint = next;
    });

  const clearEndpoint: AgentControlSessionRegistryShape["clearEndpoint"] = Effect.sync(() => {
    endpoint = null;
  });

  const currentEndpoint: AgentControlSessionRegistryShape["currentEndpoint"] = Effect.sync(() =>
    Option.fromNullishOr(endpoint),
  );

  const activeSessionCount: AgentControlSessionRegistryShape["activeSessionCount"] = Effect.sync(
    () => sessionsByDigest.size,
  );

  // Server shutdown: no credential outlives the process's runtime scope.
  yield* Effect.addFinalizer(() => revokeAll("server-shutdown"));

  return {
    issueLease,
    issueStdioBootstrap,
    exchangeStdioBootstrap,
    authenticate,
    revokeLease,
    revokeLeases,
    revokeAll,
    activeSessionCount,
    registerInFlight,
    bindTurnAuthority,
    retireTurnAuthority,
    getTurnAuthority,
    publishEndpoint,
    clearEndpoint,
    currentEndpoint,
  } satisfies AgentControlSessionRegistryShape;
});

export const AgentControlSessionRegistryLive = Layer.effect(
  AgentControlSessionRegistry,
  makeAgentControlSessionRegistry,
);
