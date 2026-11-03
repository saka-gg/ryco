import { NO_DELEGATION_LIMITS } from "../../orchestration/delegationLimits.ts";
import {
  AGENT_CONTROL_ACTION_CAPABILITIES,
  AGENT_CONTROL_CAPABILITIES,
  AgentControlProposalId,
  OrchestrationThreadShell,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type RuntimeMode,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceManager } from "../../device/DeviceManager.ts";
import type { DeviceSettleTiming } from "../../device/deviceObservation.ts";
import { FakeDeviceBackend } from "../../device/FakeDeviceBackend.ts";
import {
  DEVICE_NOT_ATTACHED_TEXT,
  DEVICE_SHARED_TEXT,
} from "../../providerTools/deviceToolActions.ts";
import { DeviceControlConsents, deviceConsentRequestId } from "../deviceControlConsent.ts";
import { AgentControlCapabilityDeniedError, AgentControlDisabledError } from "../Errors.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { SubmitAgentControlProposalInput } from "../Services/AgentControlProposalStore.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import {
  DEVICE_CONSENT_DECLINED_TEXT,
  DEVICE_CONSENT_PENDING_TEXT,
  DEVICE_CONSENT_UNANSWERED_TEXT,
  RYCO_DEVICE_TOOL,
  withDeviceRoutineTools,
  type DeviceRoutineToolDeps,
} from "./deviceRoutineTools.ts";
import {
  AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS,
  submitAgentControlMutation,
  type AgentControlMcpToolDeps,
  type AgentControlMcpToolResult,
  type AgentControlMcpTools,
} from "./tools.ts";
import { AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES } from "./transportGuard.ts";

const T0 = "2026-08-18T00:00:00.000Z";
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const UDID = "FAKE-0001";
const OTHER_UDID = "FAKE-0002";

/** Settle windows short enough for real timers. */
const FAST: Partial<DeviceSettleTiming> = {
  quietMs: 5,
  timeoutMs: 100,
  pollMs: 1,
  startDelayMs: 1,
  changeGraceMs: 5,
  appChangeTimeoutMs: 20,
};

const DEVICE_GRANTS: ReadonlyArray<AgentControlCapability> = [
  AGENT_CONTROL_CAPABILITIES.readDevices,
  AGENT_CONTROL_CAPABILITIES.readDeviceContent,
  AGENT_CONTROL_CAPABILITIES.controlDevices,
];

const session: AgentControlSessionRecord = {
  sessionId: "session-a",
  threadId: THREAD_A,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-a"),
  grantedCapabilities: DEVICE_GRANTS,
  issuedAt: T0,
  injectionMode: "codex-http",
};

const authorityFor = (turn: string): AgentControlTurnAuthority => ({
  sessionId: session.sessionId,
  threadId: THREAD_A,
  turnId: TurnId.make(turn),
  boundAt: T0,
});

const threadShell = (runtimeMode: RuntimeMode) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: THREAD_A,
    projectId: "project-1",
    title: "Device thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const baseTools: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [{ type: "text", text: "base" }], isError: true }),
};

const managers: DeviceManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function noisePng(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#202020",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
}

interface HarnessOptions {
  readonly runtimeMode?: RuntimeMode;
  readonly supported?: boolean;
  readonly attach?: boolean;
  readonly enabled?: boolean;
  /** Milliseconds each submit takes, so concurrent first calls overlap. */
  readonly submitDelayMs?: number;
}

async function harness(options: HarnessOptions = {}) {
  const backend = new FakeDeviceBackend();
  backend.bootExternally(UDID);
  backend.bootExternally(OTHER_UDID);
  const manager = new DeviceManager({ backend });
  managers.push(manager);
  if (options.attach !== false) await manager.attach(THREAD_A, UDID);

  const state = {
    /** The turn authority each `getTurnAuthority` read answers, in order; the last one repeats. */
    authorities: [authorityFor("turn-1")] as Array<AgentControlTurnAuthority | null>,
    runtimeMode: options.runtimeMode ?? ("approval-required" as RuntimeMode),
    getProposal: "store" as "store" | "none" | "fail",
    nextStatus: "pending-user-approval" as AgentControlProposalStatus,
  };
  const proposals = new Map<string, AgentControlProposal>();
  const byRequest = new Map<string, string>();
  const submitted: SubmitAgentControlProposalInput[] = [];
  const authorityReads: string[] = [];

  const policy: AgentControlPolicyShape = {
    isEnabled: Effect.succeed(options.enabled ?? true),
    delegationLimits: Effect.succeed(NO_DELEGATION_LIMITS),
    requireEnabled: () => Effect.void,
    requiredCapabilityForAction: (kind) => AGENT_CONTROL_ACTION_CAPABILITIES[kind],
    authorize: (input) =>
      options.enabled === false
        ? Effect.fail(new AgentControlDisabledError({ operation: input.operation }))
        : input.grantedCapabilities.includes(input.requiredCapability)
          ? Effect.void
          : Effect.fail(
              new AgentControlCapabilityDeniedError({
                operation: input.operation,
                capability: input.requiredCapability,
              }),
            ),
  };

  const mutationDeps: Pick<AgentControlMcpToolDeps, "validator" | "proposals"> = {
    validator: {
      validateOwnerAutomation: () => Effect.die("unused"),
      validateExternalSubmission: () => Effect.die("unused"),
      revalidateExecution: () => Effect.void,
      validateSubmission: (input) =>
        Effect.succeed({
          kind: "provider-session",
          threadId: input.session.threadId,
          providerInstanceId: input.session.providerInstanceId,
          runtimeSessionId: input.session.runtimeSessionId,
          turnId: input.authority.turnId,
        }),
    },
    proposals: {
      getProposal: (proposalId) =>
        state.getProposal === "fail"
          ? Effect.fail(new AgentControlDisabledError({ operation: "getProposal" }))
          : Effect.sync(() =>
              state.getProposal === "none"
                ? Option.none()
                : Option.fromNullishOr(proposals.get(proposalId)),
            ),
      submit: (input) =>
        Effect.promise(async () => {
          submitted.push(input);
          if (options.submitDelayMs !== undefined) await sleep(options.submitDelayMs);
          const existing = byRequest.get(input.requestId);
          if (existing !== undefined) return { proposal: proposals.get(existing)!, replayed: true };
          const proposal: AgentControlProposal = {
            proposalId: AgentControlProposalId.make(`proposal-${proposals.size + 1}`),
            requestId: input.requestId,
            principal: input.principal,
            planVersion: 1,
            plan: input.plan,
            planDigest: "a".repeat(64),
            riskTags: input.riskTags,
            promptSummary: input.promptSummary,
            status: state.nextStatus,
            createdAt: T0,
            updatedAt: T0,
            expiresAt: input.expiresAt,
            decidedAt: null,
            result: null,
          };
          proposals.set(proposal.proposalId, proposal);
          byRequest.set(input.requestId, proposal.proposalId);
          return { proposal, replayed: false };
        }),
    },
  };
  const deps: DeviceRoutineToolDeps = {
    policy,
    registry: {
      getTurnAuthority: () =>
        Effect.sync(() => {
          const next =
            state.authorities.length > 1 ? state.authorities.shift()! : state.authorities[0]!;
          authorityReads.push(next?.turnId ?? "none");
          return Option.fromNullishOr(next);
        }),
    },
    proposals: mutationDeps.proposals,
    submitMutation: (input) => submitAgentControlMutation(mutationDeps, input),
    projections: {
      getThreadShellById: () => Effect.sync(() => Option.some(threadShell(state.runtimeMode))),
    },
    deviceService: { supported: options.supported ?? true, manager },
    maxImageBase64Chars: AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS,
    consents: new DeviceControlConsents(),
    timing: FAST,
  };
  const tools = withDeviceRoutineTools(baseTools, deps);
  const call = (args: Record<string, unknown>, caller: AgentControlSessionRecord = session) =>
    Effect.runPromise(tools.callTool(caller, RYCO_DEVICE_TOOL, args));
  const setStatus = (proposalId: string, status: AgentControlProposalStatus) => {
    proposals.set(proposalId, { ...proposals.get(proposalId)!, status });
  };
  /** Every input the fake device received (screens and attachments aside). */
  const inputs = () =>
    backend.calls.filter((entry) =>
      ["tap", "swipe", "typeText", "pressButton", "launch", "testing", "keyEvent"].includes(
        entry.kind,
      ),
    );
  return {
    backend,
    manager,
    deps,
    tools,
    call,
    state,
    submitted,
    proposals,
    authorityReads,
    setStatus,
    inputs,
  };
}

const texts = (result: AgentControlMcpToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : `<${block.mimeType}>`));
const pendingProposalId = (result: AgentControlMcpToolResult) => {
  const marker = texts(result).find((text) => text.startsWith('{"consent":"pending"'));
  return marker === undefined
    ? undefined
    : (JSON.parse(marker) as { proposalId: string }).proposalId;
};
const isGuide = (text: string) => text.startsWith("- Device guide");

describe("ryco_device catalogue", () => {
  it("is offered only with device control, device content and a supported device service", async () => {
    const names = async (
      options: HarnessOptions,
      grants: ReadonlyArray<AgentControlCapability> = DEVICE_GRANTS,
    ) => {
      const { tools } = await harness(options);
      return (
        await Effect.runPromise(tools.descriptorsFor({ ...session, grantedCapabilities: grants }))
      ).map((descriptor) => descriptor.name);
    };
    expect(await names({})).toEqual([RYCO_DEVICE_TOOL]);
    expect(await names({ supported: false })).toEqual([]);
    expect(await names({ enabled: false })).toEqual([]);
    expect(
      await names({}, [
        AGENT_CONTROL_CAPABILITIES.readDevices,
        AGENT_CONTROL_CAPABILITIES.controlDevices,
      ]),
    ).toEqual([]);
    expect(
      await names({}, [
        AGENT_CONTROL_CAPABILITIES.readDevices,
        AGENT_CONTROL_CAPABILITIES.readDeviceContent,
      ]),
    ).toEqual([]);

    const { tools } = await harness();
    expect(tools.hasTool(RYCO_DEVICE_TOOL)).toBe(true);
    // Bound to the turn and registered in flight by the listener.
    expect(tools.isWriteTool(RYCO_DEVICE_TOOL)).toBe(true);
    const descriptor = tools.descriptors.find((entry) => entry.name === RYCO_DEVICE_TOOL)!;
    const schema = descriptor.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["action", "udid"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.action?.enum).toEqual([
      "tap",
      "swipe",
      "type",
      "press_button",
      "scroll_to_element",
      "launch",
      "configure",
      "describe",
      "wait",
      "logs",
    ]);
    for (const name of ["label", "x", "fromX", "durationMs", "text", "button", "maxSwipes"]) {
      expect(schema.properties).toHaveProperty(name);
    }
    for (const name of ["bundleId", "arguments", "setting", "format", "gone", "timeoutMs"]) {
      expect(schema.properties).toHaveProperty(name);
    }
    for (const name of ["sinceSeconds", "level", "contains", "limit", "observe", "screenshot"]) {
      expect(schema.properties).toHaveProperty(name);
    }
    expect(JSON.stringify(descriptor.inputSchema)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/u);
  });
});

describe("ryco_device fences", () => {
  it("refuses without the caller's exact active turn, touching nothing", async () => {
    const h = await harness();
    h.state.authorities = [null];
    const denied = await h.call({ action: "tap", udid: UDID, x: 10, y: 10 });
    expect(denied.isError).toBe(true);
    expect(texts(denied)).toEqual(["Exact active-turn device authority is unavailable."]);

    h.state.authorities = [{ ...authorityFor("turn-1"), threadId: THREAD_B }];
    expect(texts(await h.call({ action: "describe", udid: UDID }))).toEqual([
      "Exact active-turn device authority is unavailable.",
    ]);
    expect(h.backend.calls.filter((entry) => entry.kind !== "attachStream")).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it("refuses a session without the device content grant", async () => {
    const h = await harness();
    const denied = await h.call(
      { action: "describe", udid: UDID },
      { ...session, grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.controlDevices] },
    );
    expect(texts(denied)).toEqual(["Capability denied."]);
  });

  it("drives only a device attached to this thread and no other", async () => {
    const h = await harness();
    // Another device, never attached here: attaching it is the fix.
    const other = await h.call({ action: "tap", udid: OTHER_UDID, x: 1, y: 1 });
    expect(texts(other)).toEqual([DEVICE_NOT_ATTACHED_TEXT]);
    expect(DEVICE_NOT_ATTACHED_TEXT).toContain("ryco_propose_device_attach");
    // This thread's device, also watched from another thread: an attach request
    // cannot help (the validator refuses it), so the answer says who must act.
    await h.manager.attach(THREAD_B, UDID);
    const shared = await h.call({ action: "describe", udid: UDID });
    expect(texts(shared)).toEqual([DEVICE_SHARED_TEXT]);
    expect(DEVICE_SHARED_TEXT).not.toContain("ryco_propose_device_attach");
    // Attached only to the other thread: the same, not an attach suggestion.
    await h.manager.attach(THREAD_B, OTHER_UDID);
    expect(texts(await h.call({ action: "tap", udid: OTHER_UDID, x: 1, y: 1 }))).toEqual([
      DEVICE_SHARED_TEXT,
    ]);
    expect(h.submitted).toEqual([]);
    expect(h.inputs()).toEqual([]);
  });

  it("sends nothing to a device detached, or attached elsewhere, after the first fence", async () => {
    for (const [change, refusal] of [
      ["detach", DEVICE_NOT_ATTACHED_TEXT],
      ["attach elsewhere", DEVICE_SHARED_TEXT],
    ] as const) {
      const h = await harness({ runtimeMode: "full-access" });
      // The user acts in the pane while the call is past the first fence (here: while
      // the thread's runtime mode is read for the consent check).
      const tools = withDeviceRoutineTools(baseTools, {
        ...h.deps,
        projections: {
          getThreadShellById: () =>
            Effect.sync(() => {
              if (change === "detach") void h.manager.detach(THREAD_A);
              else void h.manager.attach(THREAD_B, UDID);
              return Option.some(threadShell("full-access"));
            }),
        },
      });
      for (const args of [
        { action: "tap", udid: UDID, x: 1, y: 1 },
        { action: "type", udid: UDID, text: "secret" },
      ]) {
        const result = await Effect.runPromise(tools.callTool(session, RYCO_DEVICE_TOOL, args));
        expect(result.isError).toBe(true);
        expect(texts(result).at(-1)).toBe(refusal);
      }
      expect(h.inputs()).toEqual([]);
      // Attachments stay as the user left them.
      expect(h.manager.attachedThreadIds(UDID)).toEqual(
        change === "detach" ? [] : [THREAD_A, THREAD_B],
      );
      // The pane shows no error for it: the device itself is fine.
      expect((await h.manager.getThreadState(THREAD_A)).lastError).toBeNull();
    }
  });

  it("never attaches a device: an unattached one stays unattached", async () => {
    const h = await harness({ attach: false, runtimeMode: "full-access" });
    for (const args of [
      { action: "tap", udid: UDID, x: 1, y: 1 },
      { action: "launch", udid: UDID, bundleId: "com.example.app" },
      { action: "describe", udid: UDID },
    ]) {
      expect(texts(await h.call(args))).toEqual([DEVICE_NOT_ATTACHED_TEXT]);
    }
    expect(h.backend.callsOfKind("attachStream")).toEqual([]);
    expect((await h.manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBeNull();
    expect(h.manager.attachedThreadIds(UDID)).toEqual([]);
    expect(h.backend.calls).toEqual([]);
  });

  it("offers no lifecycle, install or URL action, and no unknown argument", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    for (const args of [
      { action: "boot", udid: UDID },
      { action: "install", udid: UDID, appPath: "/tmp/App.app" },
      { action: "open_url", udid: UDID, url: "https://example.com" },
      { action: "shutdown", udid: UDID },
      { action: "tap", udid: UDID, x: 1, y: 1, url: "https://example.com" },
      { action: "tap", udid: "not a udid", x: 1, y: 1 },
      { action: "tap", x: 1, y: 1 },
    ]) {
      expect(texts(await h.call(args))).toEqual(["Invalid tool arguments."]);
    }
    expect(h.inputs()).toEqual([]);
    expect(h.submitted).toEqual([]);
  });
});

describe("ryco_device consent", () => {
  it("asks once with a content-free consent plan and sends no input until it is approved", async () => {
    const h = await harness();
    const first = await h.call({ action: "tap", udid: UDID, label: "Continue" });

    expect(first.isError).toBe(true);
    expect(first.structuredContent).toBeUndefined();
    expect(h.submitted).toHaveLength(1);
    const request = h.submitted[0]!;
    expect(request.plan).toEqual({
      kind: "deviceControlConsent",
      threadId: THREAD_A,
      projectId: "project-1",
      providerInstanceId: "codex",
      udid: UDID,
    });
    expect(request.requestId).toBe(
      deviceConsentRequestId(
        { threadId: THREAD_A, turnId: "turn-1", runtimeSessionId: "runtime-a", udid: UDID },
        1,
      ),
    );
    expect(request.requestId.length).toBeLessThanOrEqual(128);
    expect(request.riskTags).toEqual(["device-mutation"]);
    expect(request.promptSummary).toBe(`Allow routine input on device ${UDID} for this task`);
    // Nothing the agent asked to do is stored with the request.
    expect(JSON.stringify(request)).not.toContain("Continue");
    expect(JSON.stringify(request)).not.toContain('"label"');

    const proposalId = pendingProposalId(first);
    expect(proposalId).toBe("proposal-1");
    expect(texts(first).at(-1)).toBe(DEVICE_CONSENT_PENDING_TEXT);
    expect(h.inputs()).toEqual([]);

    // Still pending: the same request, no second card.
    const again = await h.call({ action: "swipe", udid: UDID, fromX: 1, fromY: 1, toX: 2, toY: 2 });
    expect(pendingProposalId(again)).toBe(proposalId);
    expect(h.submitted).toHaveLength(1);
    expect(h.inputs()).toEqual([]);
  });

  it("replays one proposal for concurrent first calls", async () => {
    const h = await harness({ submitDelayMs: 10 });
    const [left, right] = await Promise.all([
      h.call({ action: "tap", udid: UDID, x: 1, y: 1 }),
      h.call({ action: "press_button", udid: UDID, button: "home" }),
    ]);
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[0]!.requestId).toBe(h.submitted[1]!.requestId);
    expect(h.proposals.size).toBe(1);
    expect(pendingProposalId(left)).toBe("proposal-1");
    expect(pendingProposalId(right)).toBe("proposal-1");
    // One of them carries the guide, never both.
    expect([...texts(left), ...texts(right)].filter(isGuide)).toHaveLength(1);
  });

  it("runs input once the approved consent completed, returning the settled screen as private content", async () => {
    const h = await harness();
    const first = await h.call({ action: "tap", udid: UDID, x: 196, y: 725 });
    // Approved and executing are still being revalidated: no input yet, and no new card.
    for (const status of ["approved", "executing"] as const) {
      h.setStatus(pendingProposalId(first)!, status);
      const early = await h.call({ action: "tap", udid: UDID, x: 196, y: 725 });
      expect(pendingProposalId(early)).toBe(pendingProposalId(first));
      expect(h.inputs()).toEqual([]);
    }
    expect(h.submitted).toHaveLength(1);
    h.setStatus(pendingProposalId(first)!, "completed");

    const tapped = await h.call({ action: "tap", udid: UDID, x: 196, y: 725 });
    expect(tapped.isError).toBeUndefined();
    expect(tapped.structuredContent).toBeUndefined();
    expect(tapped.content.every((block) => block.type === "text")).toBe(true);
    const fields = JSON.parse(texts(tapped)[0]!) as Record<string, unknown>;
    expect(fields).toMatchObject({ udid: UDID, x: 196, y: 725, screenshot: "skipped" });
    expect(fields).toHaveProperty("settled");
    expect(fields).toHaveProperty("screenChanged");
    expect(texts(tapped)[1]).toContain('"Continue"');
    expect(h.backend.callsOfKind("tap")).toEqual([{ kind: "tap", udid: UDID, x: 196, y: 725 }]);
    expect(h.backend.callsOfKind("screenshot")).toEqual([]);

    // Granted for the rest of the task: no further request.
    const typed = await h.call({ action: "type", udid: UDID, text: "hello" });
    expect(typed.isError).toBeUndefined();
    expect(h.backend.callsOfKind("typeText")).toEqual([
      { kind: "typeText", udid: UDID, text: "hello" },
    ]);
    expect(h.submitted).toHaveLength(1);
    // The pane opens on the attached device, which stays the only attachment.
    expect(h.manager.attachedThreadIds(UDID)).toEqual([THREAD_A]);
  });

  it("binds a decline to the task: no new request, every input refused", async () => {
    const h = await harness();
    h.setStatus(
      pendingProposalId(await h.call({ action: "tap", udid: UDID, x: 1, y: 1 }))!,
      "rejected",
    );

    for (const args of [
      { action: "tap", udid: UDID, x: 1, y: 1 },
      { action: "configure", udid: UDID, setting: { type: "appearance", value: "dark" } },
    ]) {
      const declined = await h.call(args);
      expect(declined.isError).toBe(true);
      expect(texts(declined)).toEqual([DEVICE_CONSENT_DECLINED_TEXT]);
    }
    expect(h.submitted).toHaveLength(1);
    expect(h.inputs()).toEqual([]);
    // Reads still work.
    expect((await h.call({ action: "describe", udid: UDID })).isError).toBeUndefined();
  });

  it("asks once more after an expired request, then stops asking", async () => {
    const h = await harness();
    const key = { threadId: THREAD_A, turnId: "turn-1", runtimeSessionId: "runtime-a", udid: UDID };
    h.setStatus(
      pendingProposalId(await h.call({ action: "tap", udid: UDID, x: 1, y: 1 }))!,
      "expired",
    );

    const second = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(h.submitted.map((entry) => entry.requestId)).toEqual([
      deviceConsentRequestId(key, 1),
      deviceConsentRequestId(key, 2),
    ]);
    expect(pendingProposalId(second)).toBe("proposal-2");

    h.setStatus("proposal-2", "failed");
    const unanswered = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(texts(unanswered)).toEqual([DEVICE_CONSENT_UNANSWERED_TEXT]);
    expect(texts(await h.call({ action: "tap", udid: UDID, x: 1, y: 1 }))).toEqual([
      DEVICE_CONSENT_UNANSWERED_TEXT,
    ]);
    expect(h.submitted).toHaveLength(2);
    expect(h.inputs()).toEqual([]);
  });

  it("asks once more when the request is gone, and fails closed when its state is unreadable", async () => {
    const h = await harness();
    await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    h.state.getProposal = "none";
    const second = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(pendingProposalId(second)).toBe("proposal-2");
    expect(h.submitted).toHaveLength(2);

    h.state.getProposal = "fail";
    const unreadable = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(texts(unreadable)).toEqual(["Device consent state is unavailable."]);
    expect(h.inputs()).toEqual([]);
  });

  it("finds a decided request again when the index forgot it", async () => {
    const h = await harness();
    h.setStatus(
      pendingProposalId(await h.call({ action: "tap", udid: UDID, x: 1, y: 1 }))!,
      "completed",
    );
    // A fresh index (bounded eviction) replays request 1 and reads its decision.
    const forgetful = withDeviceRoutineTools(baseTools, {
      ...h.deps,
      consents: new DeviceControlConsents(),
    });
    const replayed = await Effect.runPromise(
      forgetful.callTool(session, RYCO_DEVICE_TOOL, { action: "tap", udid: UDID, x: 1, y: 1 }),
    );
    expect(replayed.isError).toBeUndefined();
    expect(h.proposals.size).toBe(1);
    expect(h.submitted.map((entry) => entry.requestId)).toEqual([
      h.submitted[0]!.requestId,
      h.submitted[0]!.requestId,
    ]);
    expect(h.backend.callsOfKind("tap")).toHaveLength(1);

    h.setStatus("proposal-1", "rejected");
    const declined = await Effect.runPromise(
      withDeviceRoutineTools(baseTools, {
        ...h.deps,
        consents: new DeviceControlConsents(),
      }).callTool(session, RYCO_DEVICE_TOOL, { action: "tap", udid: UDID, x: 1, y: 1 }),
    );
    expect(texts(declined).at(-1)).toBe(DEVICE_CONSENT_DECLINED_TEXT);
    expect(h.backend.callsOfKind("tap")).toHaveLength(1);
  });

  it("asks again for a new task, and for another device", async () => {
    const h = await harness();
    h.setStatus(
      pendingProposalId(await h.call({ action: "tap", udid: UDID, x: 1, y: 1 }))!,
      "completed",
    );
    expect((await h.call({ action: "tap", udid: UDID, x: 1, y: 1 })).isError).toBeUndefined();

    h.state.authorities = [authorityFor("turn-2")];
    const nextTask = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(pendingProposalId(nextTask)).toBe("proposal-2");

    h.setStatus("proposal-2", "completed");
    await h.manager.detach(THREAD_A);
    await h.manager.attach(THREAD_A, OTHER_UDID);
    const otherDevice = await h.call({ action: "tap", udid: OTHER_UDID, x: 1, y: 1 });
    expect(pendingProposalId(otherDevice)).toBe("proposal-3");
    expect((h.submitted[2]!.plan as { udid: string }).udid).toBe(OTHER_UDID);
    expect(h.backend.callsOfKind("tap")).toHaveLength(1);
  });

  it("skips the consent in full-access threads", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    const tapped = await h.call({ action: "tap", udid: UDID, label: "Continue" });
    expect(tapped.isError).toBeUndefined();
    expect(h.submitted).toEqual([]);
    expect(h.backend.callsOfKind("tap")).toEqual([{ kind: "tap", udid: UDID, x: 196, y: 725 }]);
  });

  it("reads without asking: describe, wait and logs", async () => {
    const h = await harness();
    const described = await h.call({ action: "describe", udid: UDID });
    expect(described.isError).toBeUndefined();
    expect(texts(described).at(-1)).toContain('"Continue"');
    const waited = await h.call({ action: "wait", udid: UDID, label: "Continue", timeoutMs: 50 });
    expect(JSON.parse(texts(waited)[0]!)).toMatchObject({ status: "ready" });
    const logs = await h.call({ action: "logs", udid: UDID, bundleId: "com.example.app" });
    expect(logs.isError).toBeUndefined();
    expect(h.backend.callsOfKind("readLogs")).toHaveLength(1);
    expect(h.submitted).toEqual([]);
    expect(h.inputs()).toEqual([]);
  });
});

describe("ryco_device results", () => {
  it("bounds typed text before touching the device", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    const tooLong = await h.call({ action: "type", udid: UDID, text: "x".repeat(4_097) });
    expect(tooLong.isError).toBe(true);
    expect(texts(tooLong).at(-1)).toBe(
      'Argument "text" must be a string of at most 4096 characters.',
    );
    expect(h.backend.callsOfKind("typeText")).toEqual([]);
  });

  it("sends the driving guide, with Agent Control's own lines, once per session", async () => {
    const h = await harness();
    const first = await h.call({ action: "describe", udid: UDID });
    const guide = texts(first)[0]!;
    expect(isGuide(guide)).toBe(true);
    expect(guide).toContain('ryco_device action "type" enters up to 4096 characters');
    expect(guide).toContain("Start with ryco_list_devices");
    expect(guide).toContain(
      'ryco_wait_for_control_request with its proposalId (waitFor "terminal")',
    );
    expect(guide).toContain("Request cancelled hit the 60 s limit");
    expect(guide).not.toMatch(/\bdevice_tap\b/u);

    const second = await h.call({ action: "describe", udid: UDID });
    expect(texts(second).some(isGuide)).toBe(false);
    // Another session (the thread's next runtime) gets its own.
    h.state.authorities = [{ ...authorityFor("turn-2"), sessionId: "session-2" }];
    const other = await h.call(
      { action: "describe", udid: UDID },
      { ...session, sessionId: "session-2", runtimeSessionId: RuntimeSessionId.make("runtime-b") },
    );
    expect(isGuide(texts(other)[0]!)).toBe(true);
  });

  it("keeps the guide for the next answer when a call fails past the fences", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    h.state.authorities = [authorityFor("turn-1"), authorityFor("turn-2")];
    const ended = await h.call({ action: "describe", udid: UDID });
    expect(texts(ended)).toEqual(["This turn has ended; no input was sent."]);
    const next = await h.call({ action: "describe", udid: UDID });
    expect(isGuide(texts(next)[0]!)).toBe(true);
  });

  it("sends no input when the turn ends while consent is looked up", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    h.state.authorities = [authorityFor("turn-1"), authorityFor("turn-2")];
    const ended = await h.call({ action: "tap", udid: UDID, x: 1, y: 1 });
    expect(texts(ended)).toEqual(["This turn has ended; no input was sent."]);
    expect(h.authorityReads).toEqual(["turn-1", "turn-2"]);
    expect(h.inputs()).toEqual([]);
  });

  it("fits a requested screenshot into Agent Control's response cap", async () => {
    const h = await harness({ runtimeMode: "full-access" });
    const png = await noisePng(1_000, 1_000);
    expect(png.toString("base64").length).toBeGreaterThan(AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES);
    h.backend.setScreenshotPng(png.toString("base64"));

    // The first call also carries the guide: the largest result this tool returns.
    const result = await h.call({ action: "tap", udid: UDID, x: 1, y: 1, screenshot: true });
    expect(result.isError).toBeUndefined();
    const image = result.content.find((block) => block.type === "image");
    expect(image?.type === "image" ? image.mimeType : null).toBe("image/jpeg");
    const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, result });
    expect(Buffer.byteLength(envelope, "utf8")).toBeLessThan(AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES);
    expect(result.structuredContent).toBeUndefined();
  });
});
