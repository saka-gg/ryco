/**
 * `ryco_device`: routine input on the device attached to the caller's thread,
 * for private Agent Control sessions.
 *
 * Lifecycle, install, URL and recording changes stay one approved proposal
 * each (`ryco_propose_device_*`). Routine input (tap, swipe, type, buttons,
 * scroll to element, launch, simulator settings) runs directly through the
 * provider gateway's shared device core (`callDeviceTool`) after one approved
 * `deviceControlConsent` per task; full-access threads skip it, as Computer Use
 * does. Reads (describe, wait, logs) need no consent. Only the device attached
 * to this thread, and to no other, can be driven; nothing here attaches one.
 *
 * Typed text, labels, coordinates, bundle ids and screens never enter
 * proposals, audit rows or structured content: they are the call's own
 * arguments and MCP content only.
 *
 * The consent flow is adapted from Synara's device-task permission
 * (`AgentGateway.ts`, commit 299fd573b); see THIRD_PARTY_NOTICES.md.
 *
 * Loaded through `import()` (`withLazyAgentControlTools`) the first time a
 * session that may drive devices lists or calls tools, never at boot. It
 * imports nothing at runtime from the tool catalogue (`tools.ts`) or its
 * neighbours: the server hands in what it needs, so loading it does not split
 * those boot-graph modules into chunks of their own.
 *
 * @module agentControl/Mcp/deviceRoutineTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlRequestId,
  DeviceUdid,
  type AgentControlProposalId,
  type ThreadId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";

import type { DeviceSettleTiming } from "../../device/deviceObservation.ts";
import type { DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { attachmentFenceRefusal } from "../../providerTools/deviceToolActions.ts";
import { DEVICE_TOOL_DEFINITIONS } from "../../providerTools/deviceToolDefinitions.ts";
import {
  AGENT_CONTROL_DEVICE_TOOL,
  callDeviceTool,
  type DeviceToolContent,
  type DeviceToolName,
} from "../../providerTools/deviceToolGateway.ts";
import {
  deviceDrivingGuide,
  type DeviceGuideNames,
} from "../../providerTools/deviceToolGuidance.ts";
import {
  DEVICE_CONSENT_MAX_ATTEMPTS,
  DeviceControlConsents,
  deviceConsentRequestId,
  deviceConsentStateFor,
  type DeviceConsentKey,
} from "../deviceControlConsent.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlProposalServiceShape } from "../Services/AgentControlProposalService.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import type { ToolFailure } from "./threadReads.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
  submitAgentControlMutation,
} from "./tools.ts";

/** A refusal in words, shaped like the catalogue's own `ToolFailure`. */
class DeviceToolFailure {
  readonly _tag = "ToolFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

type Failure = DeviceToolFailure | ToolFailure;

export const RYCO_DEVICE_TOOL = AGENT_CONTROL_DEVICE_TOOL;

/** Each action runs the provider gateway's tool of the same job. */
const ACTION_TOOL = {
  tap: "device_tap",
  swipe: "device_swipe",
  type: "device_type",
  press_button: "device_press_button",
  scroll_to_element: "device_scroll_to_element",
  launch: "device_launch",
  configure: "device_configure",
  describe: "device_describe_ui",
  wait: "device_wait",
  logs: "device_logs",
} as const satisfies Record<string, DeviceToolName>;

export type RycoDeviceAction = keyof typeof ACTION_TOOL;
const ACTIONS = Object.keys(ACTION_TOOL) as ReadonlyArray<RycoDeviceAction>;

/** Input asks the user once per task; describe, wait and logs only read. */
const NEEDS_CONSENT = new Set<RycoDeviceAction>([
  "tap",
  "swipe",
  "type",
  "press_button",
  "scroll_to_element",
  "launch",
  "configure",
]);

/**
 * One flat schema: every argument of the mapped gateway tools, which also
 * enforce them per action. Providers handle flat schemas best (no oneOf).
 */
const ACTION_PROPERTIES: Record<string, unknown> = Object.assign(
  {},
  ...DEVICE_TOOL_DEFINITIONS.filter((definition) =>
    (Object.values(ACTION_TOOL) as ReadonlyArray<DeviceToolName>).includes(definition.name),
  ).map((definition) => definition.inputSchema.properties as Record<string, unknown>),
);
const ARGUMENT_NAMES = new Set(Object.keys(ACTION_PROPERTIES));

const DESCRIPTOR: AgentControlMcpToolDescriptor = {
  name: RYCO_DEVICE_TOOL,
  description:
    "Drive the simulator or emulator attached to this thread. Actions tap, swipe, type, press_button, scroll_to_element, launch and configure ask the user once per task. describe, wait and logs only read. Inputs return the settled screen as text; pass screenshot:true for pixels. Boot, attach, install, URLs and shutdown use ryco_propose_device_*.",
  inputSchema: {
    type: "object",
    properties: {
      ...ACTION_PROPERTIES,
      action: { type: "string", enum: ACTIONS },
      udid: {
        type: "string",
        maxLength: 128,
        description: "The device attached to this thread (ryco_read_device_state).",
      },
    },
    required: ["action", "udid"],
    additionalProperties: false,
  },
};

/** The shared driving guide, with this transport's tool names. */
export const AGENT_CONTROL_GUIDE_NAMES: DeviceGuideNames = {
  list: "ryco_list_devices",
  describe: 'ryco_device action "describe"',
  screenshot: "ryco_read_device_screenshot",
  tap: 'ryco_device action "tap"',
  swipe: 'ryco_device action "swipe"',
  type: 'ryco_device action "type"',
  pressButton: 'ryco_device action "press_button"',
  scroll: 'ryco_device action "scroll_to_element"',
  launch: 'ryco_device action "launch"',
  wait: 'ryco_device action "wait"',
  logs: 'ryco_device action "logs"',
  configure: 'ryco_device action "configure"',
};

const AGENT_CONTROL_GUIDE_TRAILER = [
  'Input asks the user once per task. If a result says permission is pending, call ryco_wait_for_control_request with its proposalId (waitFor "terminal"), then repeat the call. If it was declined, do not retry. Installing, opening URLs, booting, attaching and shutting down use ryco_propose_device_* and are approved one by one.',
  "A call that fails with Request cancelled hit the 60 s limit and may still have acted: describe the screen before repeating input.",
] as const;

/** Sessions that already got the guide; bounded, oldest forgotten first. */
const GUIDED_SESSIONS_MAX = 512;

export const DEVICE_CONSENT_PENDING_TEXT =
  'Not sent. Driving this device needs the user\'s permission for this task; Ryco asked them in the chat. Call ryco_wait_for_control_request with this proposalId (waitFor "terminal"), then repeat this exact call. Do not retry before the request has settled.';
export const DEVICE_CONSENT_DECLINED_TEXT =
  "Not sent. The user declined device control for this task. Do not retry; continue without driving the device, or ask the user.";
export const DEVICE_CONSENT_UNANSWERED_TEXT =
  "Not sent. Device control for this task was not approved in time. Do not retry; continue without driving the device, or ask the user.";

export interface DeviceRoutineToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly proposals: Pick<AgentControlProposalServiceShape, "getProposal">;
  /** `submitAgentControlMutation` with the server's validator and proposal service. */
  readonly submitMutation: (
    input: Parameters<typeof submitAgentControlMutation>[1],
  ) => ReturnType<typeof submitAgentControlMutation>;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly deviceService: DeviceServiceShape;
  /** Largest base64 image in a result (`AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS`). */
  readonly maxImageBase64Chars: number;
  /** One index per tool set; tests inject their own. */
  readonly consents?: DeviceControlConsents;
  /** Tests shrink the settle windows. */
  readonly timing?: Partial<DeviceSettleTiming>;
}

/** A decoded call: the action, its device, and the arguments the gateway tool checks. */
interface RoutineInput {
  readonly action: RycoDeviceAction;
  readonly udid: DeviceUdid;
  readonly rest: Readonly<Record<string, unknown>>;
}

type ConsentAnswer =
  | { readonly kind: "granted" }
  | { readonly kind: "pending"; readonly proposalId: AgentControlProposalId }
  | { readonly kind: "declined" | "unanswered" };

/** Every answer in words is an error: nothing ran, so the agent never assumes it did. */
const errorResult = (texts: ReadonlyArray<string>): AgentControlMcpToolResult => ({
  content: texts.map((text) => ({ type: "text" as const, text })),
  isError: true,
});

/** Device content as MCP content: never `structuredContent` (private, as every device read). */
const deviceResult = (
  content: ReadonlyArray<DeviceToolContent>,
  isError: boolean,
): AgentControlMcpToolResult => ({
  content: content.map((block) => block as AgentControlMcpToolResult["content"][number]),
  ...(isError ? { isError: true } : {}),
});

const decodeUdid = Schema.decodeUnknownOption(DeviceUdid);

export function withDeviceRoutineTools(
  base: AgentControlMcpTools,
  deps: DeviceRoutineToolDeps,
): AgentControlMcpTools {
  const consents = deps.consents ?? new DeviceControlConsents();
  const guided = new Set<string>();
  const manager = deps.deviceService.manager;

  const visibleTo = (session: AgentControlSessionRecord) =>
    deps.deviceService.supported &&
    session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.controlDevices) &&
    session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.readDeviceContent);

  const decodeInput = (args: unknown): Effect.Effect<RoutineInput, DeviceToolFailure> => {
    if (args === null || typeof args !== "object" || Array.isArray(args))
      return Effect.fail(new DeviceToolFailure("Invalid tool arguments."));
    const { action, udid, ...rest } = args as Record<string, unknown>;
    const decodedUdid = decodeUdid(udid);
    if (
      typeof action !== "string" ||
      !Object.hasOwn(ACTION_TOOL, action) ||
      Option.isNone(decodedUdid) ||
      Object.keys(rest).some((name) => !ARGUMENT_NAMES.has(name))
    )
      return Effect.fail(new DeviceToolFailure("Invalid tool arguments."));
    return Effect.succeed({ action: action as RycoDeviceAction, udid: decodedUdid.value, rest });
  };

  /** The caller's exact active turn on its own thread. */
  const requireAuthority = (session: AgentControlSessionRecord) =>
    deps.registry.getTurnAuthority(session.sessionId).pipe(
      Effect.map(
        Option.filter(
          (authority) =>
            authority.sessionId === session.sessionId && authority.threadId === session.threadId,
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DeviceToolFailure("Exact active-turn device authority is unavailable."),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const authorize = (session: AgentControlSessionRecord, authority: AgentControlTurnAuthority) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          turnId: authority.turnId,
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: AGENT_CONTROL_CAPABILITIES.controlDevices,
        operation: `mcp:${RYCO_DEVICE_TOOL}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new DeviceToolFailure("Agent Control is disabled.")
            : new DeviceToolFailure("Capability denied."),
        ),
        Effect.flatMap(() =>
          // Input returns the screen, so it needs the content grant too.
          session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.readDeviceContent)
            ? Effect.void
            : Effect.fail(new DeviceToolFailure("Capability denied.")),
        ),
      );

  const consentUnavailable = () => new DeviceToolFailure("Device consent state is unavailable.");

  /**
   * The user's answer for this task and device: granted, still pending,
   * declined, or never approved. Asks (once, or once more after an expired or
   * failed request) when there is no answer yet.
   */
  const requireConsent = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    udid: DeviceUdid,
  ): Effect.Effect<ConsentAnswer, Failure> =>
    Effect.gen(function* () {
      const thread = yield* deps.projections
        .getThreadShellById(session.threadId)
        .pipe(Effect.mapError(consentUnavailable));
      if (Option.isNone(thread)) return yield* Effect.fail(consentUnavailable());
      // Such agents can already drive simulators from a shell (simctl, adb).
      if (thread.value.runtimeMode === "full-access") return { kind: "granted" } as const;

      const key: DeviceConsentKey = {
        threadId: session.threadId,
        turnId: authority.turnId,
        runtimeSessionId: session.runtimeSessionId,
        udid,
      };
      const entry = consents.lookup(key);
      // A decision binds the task: declined (or never approved) is not asked again.
      if (entry?.outcome === "granted") return { kind: "granted" } as const;
      if (entry?.outcome === "denied") return { kind: "declined" } as const;
      if (entry?.outcome === "unanswered") return { kind: "unanswered" } as const;

      let attempt = 1;
      if (entry !== undefined) {
        const proposal = yield* deps.proposals
          .getProposal(entry.proposalId)
          .pipe(Effect.mapError(consentUnavailable));
        const state = Option.isSome(proposal)
          ? deviceConsentStateFor(proposal.value.status)
          : "ask-again";
        if (state === "granted" || state === "denied") {
          consents.settle(key, state);
          return { kind: state === "granted" ? "granted" : "declined" } as const;
        }
        if (state === "pending") return { kind: "pending", proposalId: entry.proposalId } as const;
        attempt = entry.attempt + 1;
      }

      // A request id already used answers with its proposal as it stands now.
      for (; attempt <= DEVICE_CONSENT_MAX_ATTEMPTS; attempt += 1) {
        const submitted = yield* deps.submitMutation({
          session,
          authority,
          requestId: AgentControlRequestId.make(deviceConsentRequestId(key, attempt)),
          plan: {
            kind: "deviceControlConsent",
            threadId: session.threadId,
            projectId: thread.value.projectId,
            providerInstanceId: session.providerInstanceId,
            udid,
          },
        });
        const proposalId = submitted.receipt.proposalId as AgentControlProposalId;
        const state = deviceConsentStateFor(submitted.receipt.status);
        if (state === "pending") {
          consents.record(key, proposalId, attempt);
          return { kind: "pending", proposalId } as const;
        }
        if (state !== "ask-again") {
          consents.record(key, proposalId, attempt, state);
          return { kind: state === "granted" ? "granted" : "declined" } as const;
        }
        consents.record(key, proposalId, attempt);
      }
      // Never approved: like a decline, it binds the task.
      consents.settle(key, "unanswered");
      return { kind: "unanswered" } as const;
    });

  const run = (
    session: AgentControlSessionRecord,
    args: unknown,
  ): Effect.Effect<AgentControlMcpToolResult, Failure> =>
    Effect.gen(function* () {
      const input = yield* decodeInput(args);
      const authority = yield* requireAuthority(session);
      yield* authorize(session, authority);
      if (!deps.deviceService.supported)
        return yield* Effect.fail(
          new DeviceToolFailure("Simulator or emulator device control is unavailable."),
        );
      // Never a device another thread also watches, and never one this thread lacks.
      // The shared core checks again right before every input ("require-attached").
      const refusal = attachmentFenceRefusal(manager, session.threadId, input.udid);
      if (refusal !== null) return yield* Effect.fail(new DeviceToolFailure(refusal));

      // The guide goes out with the first answer past the fences (often the consent
      // request), claimed before any await so concurrent first calls send it once. A
      // failure in words (or an aborted call) below gives the claim back, so the next
      // answer carries it.
      const guide = guided.has(session.sessionId)
        ? []
        : [deviceDrivingGuide(AGENT_CONTROL_GUIDE_NAMES, { trailer: AGENT_CONTROL_GUIDE_TRAILER })];
      if (guide.length > 0) {
        guided.add(session.sessionId);
        if (guided.size > GUIDED_SESSIONS_MAX) {
          const oldest = guided.values().next();
          if (oldest.done !== true) guided.delete(oldest.value);
        }
      }
      return yield* answer(session, input, authority, guide).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (guide.length > 0) guided.delete(session.sessionId);
          }),
        ),
      );
    });

  /** Past the fences: consent for input, the turn once more, then the device. */
  const answer = (
    session: AgentControlSessionRecord,
    input: RoutineInput,
    authority: AgentControlTurnAuthority,
    guide: ReadonlyArray<string>,
  ): Effect.Effect<AgentControlMcpToolResult, Failure> =>
    Effect.gen(function* () {
      if (NEEDS_CONSENT.has(input.action)) {
        const consent = yield* requireConsent(session, authority, input.udid);
        switch (consent.kind) {
          case "pending":
            return errorResult([
              ...guide,
              JSON.stringify({ consent: "pending", proposalId: consent.proposalId }),
              DEVICE_CONSENT_PENDING_TEXT,
            ]);
          case "declined":
            return errorResult([...guide, DEVICE_CONSENT_DECLINED_TEXT]);
          case "unanswered":
            return errorResult([...guide, DEVICE_CONSENT_UNANSWERED_TEXT]);
          case "granted":
            break;
        }
      }

      // The task may have ended while consent was looked up.
      const current = yield* deps.registry.getTurnAuthority(session.sessionId);
      if (
        Option.isNone(current) ||
        current.value.turnId !== authority.turnId ||
        current.value.threadId !== session.threadId
      )
        return yield* Effect.fail(new DeviceToolFailure("This turn has ended; no input was sent."));

      const threadId: ThreadId = session.threadId;
      const result = yield* Effect.tryPromise({
        // The listener aborts this signal when the turn retires or the caller goes away;
        // it reaches every settle and wait loop, and every step of a label tap or scroll.
        try: (signal) =>
          callDeviceTool({
            manager,
            threadId,
            name: ACTION_TOOL[input.action],
            args: { udid: input.udid, ...input.rest },
            signal,
            attachment: "require-attached",
            maxImageBase64Chars: deps.maxImageBase64Chars,
            timing: deps.timing,
          }),
        catch: () => new DeviceToolFailure("Device control failed."),
      });
      return deviceResult(
        [...guide.map((text) => ({ type: "text" as const, text })), ...result.content],
        result.isError === true,
      );
    });

  const call = (
    session: AgentControlSessionRecord,
    args: unknown,
  ): Effect.Effect<AgentControlMcpToolResult> =>
    run(session, args).pipe(
      Effect.catch((failure) => Effect.succeed(errorResult([failure.reason]))),
      Effect.catchDefect(() => Effect.succeed(errorResult(["Tool execution failed."]))),
    );

  return {
    ...base,
    descriptors: [...base.descriptors, DESCRIPTOR],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled) || !visibleTo(session)) return tools;
        return [...tools, DESCRIPTOR];
      }),
    hasTool: (name) => name === RYCO_DEVICE_TOOL || base.hasTool(name),
    // Bound to the turn and registered in flight: retiring the turn aborts the call.
    isWriteTool: (name) => name === RYCO_DEVICE_TOOL || base.isWriteTool(name),
    callTool: (session, name, args) =>
      name === RYCO_DEVICE_TOOL ? call(session, args) : base.callTool(session, name, args),
  };
}
