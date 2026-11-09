import * as Schema from "effect/Schema";
import {
  AgentControlAutomation,
  AgentControlAutomationDefinition,
  AgentControlAutomationId,
  AgentControlAutomationRun,
  AgentControlAutomationRunId,
  AgentControlProposal,
  AgentControlRequestId,
} from "./agentControl.ts";
import {
  ProjectId,
  ThreadId,
  PositiveInt,
  NonNegativeInt,
  IsoDateTime,
  rejectExcessProperties,
} from "./baseSchemas.ts";

export const AutomationCentreInput = Schema.Struct({ projectId: ProjectId });
export type AutomationCentreInput = typeof AutomationCentreInput.Type;
export const AutomationCentreRun = Schema.Struct({
  run: AgentControlAutomationRun,
  execution: Schema.NullOr(AgentControlAutomationDefinition.fields.execution),
  threadIds: Schema.Array(ThreadId),
  unread: Schema.Boolean,
  retryOfRunId: Schema.NullOr(AgentControlAutomationRunId),
});
export type AutomationCentreRun = typeof AutomationCentreRun.Type;
export const AutomationCentreSnapshot = Schema.Struct({
  automations: Schema.Array(AgentControlAutomation),
  runs: Schema.Array(AutomationCentreRun),
  proposals: Schema.Array(AgentControlProposal),
  unavailableRecords: NonNegativeInt,
  /** This bounded view does not imply complete history. */
  historyLimit: PositiveInt,
  /** The node lets the owner set `runPolicy: "run-without-asking"`; absent on older nodes. */
  runWithoutAsking: Schema.optional(Schema.Literal(true)),
  /**
   * The node takes a schedule that runs into an existing chat (`execution.target`) from the
   * owner's editor; absent on older nodes, which refuse the key.
   */
  heartbeats: Schema.optional(Schema.Literal(true)),
  /**
   * The node takes a schedule whose trigger is its webhook (`{ kind: "webhook" }`,
   * `docs/automation-webhooks.md`) from the owner's editor; absent on older nodes.
   */
  webhooks: Schema.optional(Schema.Literal(true)),
});
export type AutomationCentreSnapshot = typeof AutomationCentreSnapshot.Type;
const commandScope = { projectId: ProjectId, requestId: AgentControlRequestId };
export const AutomationCentreCommand = Schema.Union([
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("save"),
    automationId: AgentControlAutomationId,
    expectedRevision: Schema.NullOr(PositiveInt),
    definition: AgentControlAutomationDefinition,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("cancel"),
    automationId: AgentControlAutomationId,
    expectedRevision: PositiveInt,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("retry"),
    runId: AgentControlAutomationRunId,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("read"),
    runId: AgentControlAutomationRunId,
    expectedUpdatedAt: IsoDateTime,
    unread: Schema.Boolean,
  }),
]).pipe(rejectExcessProperties);
export type AutomationCentreCommand = typeof AutomationCentreCommand.Type;

/** The owner reads a webhook schedule's hook, or replaces its secret (`regenerate`). */
export const AutomationHookInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AgentControlAutomationId,
  action: Schema.Literals(["read", "regenerate"]),
}).pipe(rejectExcessProperties);
export type AutomationHookInput = typeof AutomationHookInput.Type;

/** What the node did with a hook's latest request. */
export const AutomationHookRequestOutcome = Schema.Literals([
  /** A run started (run without asking). */
  "started",
  /** The run waits for approval (ask each time). */
  "awaiting-approval",
  /** A delivery handled before: nothing new ran. */
  "duplicate",
  /** GitHub's test when a webhook is added: nothing ran. */
  "ping",
  "unauthorized",
  "not-accepting",
  "rate-limited",
  /** A run of the schedule was still waiting for approval or starting: try again later. */
  "busy",
  "too-large",
  /** The node could not take it; the sender may retry. */
  "failed",
]);
export type AutomationHookRequestOutcome = typeof AutomationHookRequestOutcome.Type;

export const AutomationHookView = Schema.Struct({
  automationId: AgentControlAutomationId,
  hookId: Schema.String,
  /** Only for the owner principal. */
  secret: Schema.String,
  /** `/api/automation-hooks/<hookId>`, on any origin a sender reaches this node at. */
  directPath: Schema.String,
  /** `https://<hub>/hooks/<hookId>`, when this node has a Hub. */
  cloudUrl: Schema.NullOr(Schema.String),
  /**
   * `registered`: the Hub took the hook at its last sync. `pending`: not yet (offline, or a sync
   * is due). `unsupported`: the Hub predates hooks. `paused`: a paused schedule's hook is not
   * offered to the Hub. `none`: no Hub.
   */
  cloudState: Schema.Literals(["registered", "pending", "unsupported", "paused", "none"]),
  createdAt: IsoDateTime,
  secretUpdatedAt: IsoDateTime,
  lastRequest: Schema.NullOr(
    Schema.Struct({
      at: IsoDateTime,
      via: Schema.Literals(["cloud", "direct"]),
      outcome: AutomationHookRequestOutcome,
    }),
  ),
});
export type AutomationHookView = typeof AutomationHookView.Type;

export interface AutomationCentreApi {
  readonly snapshot: (input: AutomationCentreInput) => Promise<AutomationCentreSnapshot>;
  readonly command: (input: AutomationCentreCommand) => Promise<AutomationCentreSnapshot>;
  /** Absent before webhook triggers. */
  readonly hook?: (input: AutomationHookInput) => Promise<AutomationHookView>;
}
