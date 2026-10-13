/**
 * How a fork's provider continues, decided when the fork is accepted.
 *
 * A native copy is only a candidate when it can end exactly at the boundary: the source's
 * persisted binding belongs to the instance its model selection names, that instance is an
 * enabled Codex or Claude instance, and the binding holds a resumable native session whose
 * transcript is at a provable point. Everything else continues through a context handoff built
 * from the fork's own (copied) history. A Claude candidate still needs its cutoff pinned against
 * the source transcript while the fork is accepted (`pinClaudeForkPlan`). The run still verifies
 * the turn is in the native session and may hand off then (`turn-not-in-native-session`,
 * `native-fork-failed`, `native-fork-uncertain`).
 *
 * Pure: no services, no clocks.
 */
import type { ProviderInstanceConfig, ProviderInstanceId } from "@ryco/contracts";
import { Schema } from "effect";

import { readClaudeResumeState } from "../provider/claudeResumeCursor.ts";
import { CodexResumeCursorSchema } from "../provider/codexResumeCursor.ts";
import { readPersistedCwd } from "../provider/runtimeCwd.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ForkBoundary } from "./forkBoundary.ts";
import type { ThreadForkNativeDriver, ThreadForkProviderPlan } from "./forkLedger.ts";
import { type ClaudeCutoffPin, nativeForkConfigFingerprint } from "./nativeFork.ts";

type ClaudeProviderPlan = Extract<ThreadForkProviderPlan, { readonly driver: "claudeAgent" }>;

/** A Claude native candidate: everything but the cutoff, which acceptance pins next. */
export interface ClaudeNativeCandidate {
  readonly kind: "claude-candidate";
  readonly plan: Omit<ClaudeProviderPlan, "cutoff">;
}

const NATIVE_FORK_DRIVERS: ReadonlySet<string> = new Set<ThreadForkNativeDriver>([
  "codex",
  "claudeAgent",
]);

const isNativeForkDriver = (driver: string): driver is ThreadForkNativeDriver =>
  NATIVE_FORK_DRIVERS.has(driver);

const handoff = (reason: Extract<ThreadForkProviderPlan, { kind: "handoff" }>["reason"]) =>
  ({ kind: "handoff", reason }) as const satisfies ThreadForkProviderPlan;

/** The native session a binding resumes, or why it cannot be forked exactly. */
function bindingNativeSession(
  driver: ThreadForkNativeDriver,
  resumeCursor: unknown,
): { readonly sessionId: string } | { readonly unprovable: true } | null {
  if (driver === "codex") {
    return Schema.is(CodexResumeCursorSchema)(resumeCursor) &&
      resumeCursor.threadId.trim().length > 0
      ? { sessionId: resumeCursor.threadId }
      : null;
  }
  const state = readClaudeResumeState(resumeCursor);
  if (state?.resume === undefined) return null;
  // A checkpoint revert pins later resumes to an earlier entry until a turn completes on the
  // rewound branch: until then the transcript's newest leaf is not the conversation's head.
  if (state.rewindAt !== undefined) return { unprovable: true };
  return { sessionId: state.resume };
}

export function planForkProvider(input: {
  /** The source's model selection instance: the fork inherits it. */
  readonly instanceId: ProviderInstanceId;
  /** That instance's configuration, when it still exists. */
  readonly config: ProviderInstanceConfig | undefined;
  /** The source's persisted provider binding. */
  readonly binding: ProviderRuntimeBinding | undefined;
  readonly boundary: Pick<ForkBoundary, "turnId" | "inheritedUserTurnCount">;
}): ThreadForkProviderPlan | ClaudeNativeCandidate {
  const { config, binding } = input;
  if (config === undefined) return handoff("no-native-session");
  if (!isNativeForkDriver(config.driver)) return handoff("provider-unsupported");
  const driver = config.driver;
  if (config.enabled === false) return handoff("no-native-session");
  if (
    binding === undefined ||
    binding.providerInstanceId !== input.instanceId ||
    binding.provider !== driver
  ) {
    return handoff("no-native-session");
  }
  const recordedCwd = readPersistedCwd(binding.runtimePayload);
  const session = bindingNativeSession(driver, binding.resumeCursor);
  if (recordedCwd === undefined || session === null) return handoff("no-native-session");
  if ("unprovable" in session) return handoff("turn-not-in-native-session");
  const common = {
    kind: "native",
    instanceId: input.instanceId,
    configFingerprint: nativeForkConfigFingerprint(config),
    sourceNativeId: session.sessionId,
    recordedCwd,
    turnId: input.boundary.turnId,
    inheritedUserTurnCount: input.boundary.inheritedUserTurnCount,
  } as const;
  return driver === "codex"
    ? { ...common, driver }
    : { kind: "claude-candidate", plan: { ...common, driver } };
}

/**
 * Completes a Claude candidate with the cutoff read from the source transcript at acceptance.
 * A cutoff at the transcript's tail only ends the boundary turn when the caller proved nothing
 * was appended after it (`tailProven`): no later turn, queued prompt or running session around
 * the read. Anything unproven hands off; the run never derives a cutoff from a later read.
 */
export function pinClaudeForkPlan(
  candidate: ClaudeNativeCandidate,
  pin: ClaudeCutoffPin,
  tailProven: boolean,
): ThreadForkProviderPlan {
  switch (pin.kind) {
    case "turn-not-in-session":
      return handoff("turn-not-in-native-session");
    case "refused":
      return handoff("native-fork-failed");
    case "pinned":
      return pin.atTail && !tailProven
        ? handoff("turn-not-in-native-session")
        : { ...candidate.plan, cutoff: pin.cutoff };
  }
}
