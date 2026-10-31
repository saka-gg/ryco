/**
 * `ryco_request_secret`: an agent asks the user for a secret (an API key, a token) through a
 * private card in its own thread (docs/secret-requests.md). The node writes the answer into a
 * Git-ignored dotenv file of the caller's own checkout; the agent only ever hears pending,
 * provided, declined or expired.
 *
 * Private provider sessions only (never the external endpoint), with exact active-turn authority
 * and the `secrets.request` grant, which the user can revoke like any other. Loaded on first use
 * (`withLazyAgentControlTools`).
 *
 * @module agentControl/Mcp/secretRequestTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
  SECRET_REQUEST_DEFAULT_FILE,
  SECRET_REQUEST_FILE_MAX_CHARS,
  SECRET_REQUEST_MAX_PENDING_PER_THREAD,
  SECRET_REQUEST_PURPOSE_MAX_CHARS,
  SECRET_REQUEST_WAIT_MS_DEFAULT,
  SECRET_REQUEST_WAIT_MS_MAX,
  SECRET_RESOLVED_ACTIVITY_KIND,
  type OrchestrationEvent,
} from "@ryco/contracts";
import {
  AgentControlRequestSecretInput,
  type SecretRequestStatus,
} from "@ryco/contracts/secret-request-details";
import type { SecretRequestView } from "@ryco/shared/secretRequests";
import { Effect, Option, Schema } from "effect";

import type { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  currentSecretRequest,
  openSecretRequest,
  SecretRequestOpenError,
  type SecretRequestDeps,
} from "../../secretRequests/secretRequests.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

export const SECRET_REQUEST_TOOL_DESCRIPTOR: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
  description:
    "Ask the user for a secret (an API key, token or password) through a private card in this thread. Never ask for secrets in chat; use this tool. The user types the value on the card and Ryco writes it as KEY='value' into a dotenv file in this thread's own checkout (default .env). The value is never shown to you, the transcript or any response: the result says only pending, provided, declined or expired. The file must be ignored by Git (add it to .gitignore first) and named like .env, .env.local, name.env or .dev.vars. While pending, call again with the same requestId to keep waiting, or end your turn and tell the user the card is waiting. Once provided, load the key from the environment in your code; never print, log or copy the value, and do not read the file to see it. Requests expire after 24 hours.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Your id for this request; reuse it to keep waiting on the same card.",
      },
      key: {
        type: "string",
        pattern: "^[A-Z_][A-Z0-9_]{0,127}$",
        description: "The environment variable name, e.g. STRIPE_SECRET_KEY.",
      },
      purpose: {
        type: "string",
        minLength: 1,
        maxLength: SECRET_REQUEST_PURPOSE_MAX_CHARS,
        description: "One short sentence the card shows: what the key is for.",
      },
      file: {
        type: "string",
        minLength: 1,
        maxLength: SECRET_REQUEST_FILE_MAX_CHARS,
        description: `Dotenv file relative to this thread's checkout. Default ${SECRET_REQUEST_DEFAULT_FILE}.`,
      },
      waitMs: { type: "integer", minimum: 0, maximum: SECRET_REQUEST_WAIT_MS_MAX },
    },
    required: ["requestId", "key", "purpose"],
    additionalProperties: false,
  },
};

const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";

const NEXT_STEP: Record<SecretRequestStatus, string> = {
  pending:
    "The user has not answered yet. Call ryco_request_secret again with the same requestId to keep waiting, or end your turn and tell the user the card is waiting. Do not ask for the value in chat.",
  provided:
    "The user saved it. Load it from the environment in your code; never print, log or copy the value, and do not read the file to see it.",
  declined:
    "The user declined. Do not ask for the value in chat; continue without it or ask the user how to proceed.",
  expired: "The request expired unanswered. Ask again with a new requestId if you still need it.",
};

const textResult = (value: unknown, note: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: `${JSON.stringify(value)}\n${note}` }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export interface SecretRequestToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly engine: SecretRequestDeps["engine"] &
    Pick<OrchestrationEngineShape, "subscribeDomainEvents">;
  readonly projections: SecretRequestDeps["projections"];
  readonly workspaceAccess?: SecretRequestDeps["workspaceAccess"];
  /** Boot-path helpers, passed in so this lazily loaded module does not split them out. */
  readonly helpers: {
    readonly findThreadInArray: SecretRequestDeps["findThreadInArray"];
    readonly waitUntil: typeof waitUntil;
    readonly threadWakeSource: typeof threadWakeSource;
  };
}

const isResolutionEvent = (event: OrchestrationEvent) =>
  event.type === "thread.activity-appended" &&
  event.payload.activity.kind === SECRET_RESOLVED_ACTIVITY_KIND;

export function withSecretRequestTools(
  base: AgentControlMcpTools,
  deps: SecretRequestToolDeps,
): AgentControlMcpTools {
  const descriptor = SECRET_REQUEST_TOOL_DESCRIPTOR;
  const capability = AGENT_CONTROL_CAPABILITIES.requestSecrets;
  const requestDeps: SecretRequestDeps = {
    engine: deps.engine,
    projections: deps.projections,
    workspaceAccess: deps.workspaceAccess,
    findThreadInArray: deps.helpers.findThreadInArray,
  };

  const request = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const authority = Option.filter(
        yield* deps.registry.getTurnAuthority(session.sessionId),
        (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
      );
      if (Option.isNone(authority)) {
        return yield* Effect.fail(new SecretRequestOpenError(NO_AUTHORITY));
      }
      yield* deps.policy
        .authorize({
          principal: {
            kind: "provider-session",
            threadId: session.threadId,
            providerInstanceId: session.providerInstanceId,
            runtimeSessionId: session.runtimeSessionId,
            turnId: authority.value.turnId,
          },
          grantedCapabilities: session.grantedCapabilities,
          requiredCapability: capability,
          operation: `mcp:${descriptor.name}`,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "AgentControlDisabledError"
              ? new SecretRequestOpenError("Agent Control is disabled.")
              : new SecretRequestOpenError("Capability denied."),
          ),
        );
      const input = yield* Schema.decodeUnknownEffect(AgentControlRequestSecretInput)(
        args ?? {},
      ).pipe(Effect.mapError(() => new SecretRequestOpenError("Invalid tool arguments.")));
      // The card is shown in, and its file written to, the caller's own thread: never another.
      const opened = yield* openSecretRequest(requestDeps, {
        threadId: session.threadId,
        turnId: authority.value.turnId,
        callerRequestId: input.requestId,
        key: input.key,
        purpose: input.purpose,
        file: input.file ?? SECRET_REQUEST_DEFAULT_FILE,
        maxPending: SECRET_REQUEST_MAX_PENDING_PER_THREAD,
      });
      const outcome = yield* deps.helpers.waitUntil({
        sources: [
          deps.helpers.threadWakeSource(deps.engine, [session.threadId], isResolutionEvent),
        ],
        check: currentSecretRequest(requestDeps, session.threadId, opened.requestId).pipe(
          Effect.map((current: SecretRequestView | undefined) => ({
            done: current === undefined || current.status !== "pending",
            value: current,
          })),
        ),
        timeoutMs: input.waitMs ?? SECRET_REQUEST_WAIT_MS_DEFAULT,
      });
      const current = outcome.value;
      if (current === undefined) {
        return yield* Effect.fail(new SecretRequestOpenError("The request no longer exists."));
      }
      const result = {
        requestId: input.requestId,
        key: current.key,
        file: current.file,
        status: current.status,
        expiresAt: current.expiresAt,
      };
      return textResult(result, NEXT_STEP[current.status]);
    });

  return {
    ...base,
    descriptors: [...base.descriptors, descriptor],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return session.grantedCapabilities.includes(capability) ? [...tools, descriptor] : tools;
      }),
    hasTool: (name) => name === descriptor.name || base.hasTool(name),
    isWriteTool: (name) => name === descriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) =>
      name === descriptor.name
        ? request(session, args).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                errorResult(
                  error instanceof SecretRequestOpenError
                    ? error.text
                    : "The secret request failed.",
                ),
              ),
            ),
          )
        : base.callTool(session, name, args),
  };
}
