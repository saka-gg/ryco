import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlIntegrationId,
  type AgentControlExternalIntegration,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Redacted, Ref } from "effect";

import { AgentControlExternalIntegrationError } from "../Errors.ts";
import type { AgentControlExternalIntegrationServiceShape } from "../Services/AgentControlExternalIntegration.ts";
import { AGENT_CONTROL_MCP_MAX_BODY_BYTES } from "../Mcp/transportGuard.ts";
import { AGENT_CONTROL_EXTERNAL_PAIR_PATH, makeAgentControlExternalListener } from "./listener.ts";
import type { ExternalMcpTools } from "./tools.ts";

const integrationId = AgentControlIntegrationId.make("integration-listener");
const credential = `rycoext_${"A".repeat(43)}`;
const pairingCode = "ABCD234567";

const integration: AgentControlExternalIntegration = {
  integrationId,
  displayName: "Listener client",
  clientKind: "generic-mcp",
  projectScope: { kind: "all" },
  capabilities: [AGENT_CONTROL_CAPABILITIES.externalReadTask],
  rateLimitPerMinute: 60,
  activeTaskLimit: 1,
  activeTaskCount: 0,
  expiresAt: null,
  revokedAt: null,
  pairingState: "paired",
  pairingCodeExpiresAt: null,
  pairedAt: "2026-08-18T00:00:00.000Z",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastUsedAt: null,
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text(), headers: response.headers };
  });

it.live("serves pairing and MCP only on its private loopback listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paired = yield* Ref.make(false);
      const revoked = yield* Ref.make(false);
      const integrations = {
        exchangePairing: (input: {
          readonly integrationId: string;
          readonly pairingCode: string;
        }) =>
          Effect.gen(function* () {
            if (
              input.integrationId !== integrationId ||
              input.pairingCode !== pairingCode ||
              (yield* Ref.get(paired))
            ) {
              return yield* new AgentControlExternalIntegrationError({
                reason: "pairing-refused",
              });
            }
            yield* Ref.set(paired, true);
            return { integrationId, credential: Redacted.make(credential) };
          }),
        authenticate: (authorization: string | undefined) =>
          Effect.gen(function* () {
            if (
              authorization !== `Bearer ${credential}` ||
              !(yield* Ref.get(paired)) ||
              (yield* Ref.get(revoked))
            ) {
              return yield* new AgentControlExternalIntegrationError({
                reason: "credential-refused",
              });
            }
            return { integration };
          }),
        authorizeTool: () =>
          Ref.get(revoked).pipe(
            Effect.flatMap((isRevoked) =>
              isRevoked
                ? Effect.fail(new AgentControlExternalIntegrationError({ reason: "revoked" }))
                : Effect.succeed(integration),
            ),
          ),
      } as unknown as AgentControlExternalIntegrationServiceShape;
      const tools: ExternalMcpTools = {
        descriptorsFor: () => [],
        hasTool: () => false,
        callTool: () => Effect.die("not used"),
      };
      const listener = yield* makeAgentControlExternalListener({ integrations, tools });
      assert.match(listener.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.strictEqual(
        listener.pairingUrl,
        listener.url.replace(/\/mcp$/, AGENT_CONTROL_EXTERNAL_PAIR_PATH),
      );

      const browserPair = yield* post(
        listener.pairingUrl,
        { integrationId, pairingCode },
        { cookie: "ryco_session=browser" },
      );
      assert.strictEqual(browserPair.status, 403);

      const first = yield* post(listener.pairingUrl, { integrationId, pairingCode });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.headers.get("cache-control"), "no-store");
      assert.deepStrictEqual(JSON.parse(first.body), {
        integrationId,
        audience: "external-mcp",
        credential,
      });
      assert.strictEqual(
        (yield* post(listener.pairingUrl, { integrationId, pairingCode })).status,
        401,
      );

      const internalCredential = yield* post(
        listener.url,
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { authorization: `Bearer rycoac_${"B".repeat(43)}` },
      );
      assert.strictEqual(internalCredential.status, 401);
      const ping = yield* post(
        listener.url,
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { authorization: `Bearer ${credential}` },
      );
      assert.strictEqual(ping.status, 200);
      // External integrations keep the small body bound; only the private listener takes pages.
      const oversized = yield* post(
        listener.url,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "ping",
          params: { padding: "y".repeat(AGENT_CONTROL_MCP_MAX_BODY_BYTES) },
        },
        { authorization: `Bearer ${credential}` },
      );
      assert.strictEqual(oversized.status, 413);

      const publicPath = yield* post(
        listener.url.replace(/\/mcp$/, "/mcp/external"),
        { jsonrpc: "2.0", id: 3, method: "ping" },
        { authorization: `Bearer ${credential}` },
      );
      assert.strictEqual(publicPath.status, 404);

      yield* Ref.set(revoked, true);
      const afterRevocation = yield* post(
        listener.url,
        { jsonrpc: "2.0", id: 4, method: "ping" },
        { authorization: `Bearer ${credential}` },
      );
      assert.strictEqual(afterRevocation.status, 401);
    }),
  ),
);
