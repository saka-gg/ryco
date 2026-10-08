/**
 * The per-turn delivery sequence shared by the private tools that show a
 * stored attachment in the caller's thread (`ryco_attach_file`,
 * `ryco_html_render`): exact active-turn authority, the capability check,
 * durable idempotency and the per-turn attachment budget from a bounded turn
 * read, then a re-check of the turn binding right before the attachment is
 * dispatched as its own assistant message in that turn.
 *
 * @module agentControl/Mcp/turnAttachmentDelivery
 */
import {
  type AgentControlCapability,
  type ChatAttachment,
  CommandId,
  type MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
} from "@ryco/contracts";
import { Data, Effect, Option, Semaphore } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";

/** A delivery refusal. `reason` is written for the agent and says what to do next. */
export class TurnAttachmentDeliveryError extends Data.TaggedError("TurnAttachmentDeliveryError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const refuse = (reason: string) => Effect.fail(new TurnAttachmentDeliveryError({ reason }));

// One bounded read covers a turn; a turn with more messages fails closed.
const TURN_MESSAGE_READ_LIMIT = 1000;

export interface TurnAttachmentDeliveryDeps {
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly policy: Pick<AgentControlPolicyShape, "authorize">;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "listThreadMessagesByTurn">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
}

export interface TurnAttachmentBudget {
  /** This delivery's message is already in the turn: an idempotent repeat. */
  readonly delivered: boolean;
  /** Bytes left in the turn's attachment budget. */
  readonly remainingBytes: number;
}

export interface TurnAttachmentDelivery {
  /** Exact active-turn authority for the session's own thread, then the capability. */
  readonly authorize: (
    session: AgentControlSessionRecord,
    input: { readonly capability: AgentControlCapability; readonly operation: string },
  ) => Effect.Effect<AgentControlTurnAuthority, TurnAttachmentDeliveryError>;
  /** Idempotency and the per-turn count/byte budget over every assistant attachment. */
  readonly budget: (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    messageId: MessageId,
  ) => Effect.Effect<TurnAttachmentBudget, TurnAttachmentDeliveryError>;
  /**
   * Re-checks that the same turn binding is still current, then dispatches
   * the attachment as an assistant message in it. `onDispatch` runs right
   * before the command is handed to the engine; after that the message may
   * exist even if this effect fails or is interrupted.
   */
  readonly publish: (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: {
      readonly messageId: MessageId;
      readonly commandId: CommandId;
      readonly attachment: ChatAttachment;
      readonly onDispatch?: () => void;
    },
  ) => Effect.Effect<void, TurnAttachmentDeliveryError>;
  /**
   * Serializes budget checks and publication across concurrent calls, so two
   * deliveries cannot both pass the same budget check.
   */
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const makeTurnAttachmentDelivery = (
  deps: TurnAttachmentDeliveryDeps,
): Effect.Effect<TurnAttachmentDelivery> =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(1);

    const authorize: TurnAttachmentDelivery["authorize"] = (session, input) =>
      Effect.gen(function* () {
        const authority = yield* deps.registry.getTurnAuthority(session.sessionId);
        if (
          Option.isNone(authority) ||
          authority.value.threadId !== session.threadId ||
          authority.value.sessionId !== session.sessionId
        )
          return yield* refuse(
            "An exact active turn is required: call this tool during your own turn in this thread.",
          );
        yield* deps.policy
          .authorize({
            principal: {
              kind: "provider-session",
              threadId: session.threadId,
              runtimeSessionId: session.runtimeSessionId,
              providerInstanceId: session.providerInstanceId,
              turnId: authority.value.turnId,
            },
            requiredCapability: input.capability,
            grantedCapabilities: session.grantedCapabilities,
            operation: input.operation,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new TurnAttachmentDeliveryError({
                  reason:
                    error._tag === "AgentControlDisabledError"
                      ? "Agent Control is disabled."
                      : `This session is not permitted to use ${input.operation.replace(/^mcp:/, "")}.`,
                }),
            ),
          );
        return authority.value;
      });

    const budget: TurnAttachmentDelivery["budget"] = (session, authority, messageId) =>
      Effect.gen(function* () {
        const listThreadMessagesByTurn = deps.projections.listThreadMessagesByTurn;
        if (!listThreadMessagesByTurn)
          return yield* refuse("Attachment delivery is unavailable on this server.");
        const messages = yield* listThreadMessagesByTurn({
          threadId: session.threadId,
          turnId: authority.turnId,
          limit: TURN_MESSAGE_READ_LIMIT,
        }).pipe(
          Effect.mapError(
            () =>
              new TurnAttachmentDeliveryError({
                reason: "This turn's attachments could not be read. Try again.",
              }),
          ),
        );
        if (messages.length >= TURN_MESSAGE_READ_LIMIT)
          return yield* refuse("This turn has too many messages to check its attachment budget.");
        if (messages.find((message) => message.id === messageId)?.attachments?.length)
          return { delivered: true, remainingBytes: 0 };
        const attached = messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.attachments ?? []);
        if (attached.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
          return yield* refuse(
            `This turn already delivered ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments, the most one turn can show.`,
          );
        return {
          delivered: false,
          remainingBytes:
            PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES -
            attached.reduce((total, attachment) => total + (attachment.sizeBytes ?? 0), 0),
        };
      });

    const publish: TurnAttachmentDelivery["publish"] = (session, authority, input) =>
      Effect.gen(function* () {
        const current = yield* deps.registry.getTurnAuthority(session.sessionId);
        if (
          Option.isNone(current) ||
          current.value.turnId !== authority.turnId ||
          current.value.boundAt !== authority.boundAt
        )
          return yield* refuse("The turn ended before the attachment could be shown.");
        input.onDispatch?.();
        yield* deps.engine
          .dispatch({
            type: "thread.message.assistant.complete",
            commandId: input.commandId,
            threadId: session.threadId,
            messageId: input.messageId,
            turnId: authority.turnId,
            text: " ",
            attachments: [input.attachment],
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError(
              () =>
                new TurnAttachmentDeliveryError({
                  reason: "The attachment could not be added to the thread. Try again.",
                }),
            ),
          );
      });

    return {
      authorize,
      budget,
      publish,
      serialized: (effect) => permits.withPermits(1)(effect),
    } satisfies TurnAttachmentDelivery;
  });
