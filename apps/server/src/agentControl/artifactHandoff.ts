/**
 * Handing artifacts (`@ryco/shared/threadArtifacts`) from one thread to another: a delegating
 * parent's to the child it creates (`ryco_create_threads` entry `artifacts`), and a delegated
 * child's own back to its parent with the returned result.
 *
 * A handover never shares a file. Each artifact is copied (hard-linked where possible) under
 * the receiving thread's own attachment id, as a fork inherits its attachments, so deleting or
 * reverting either thread never touches the other's copy. The copy names where it came from
 * (`handoff`); that is provenance only, never authority to read the source thread.
 *
 * @module agentControl/artifactHandoff
 */
import {
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  type ThreadId,
} from "@ryco/contracts";
import { isThreadArtifactAttachment, parseThreadArtifactId } from "@ryco/shared/threadArtifacts";
import { Data, Effect, Option } from "effect";

import { isPersistableChatAttachment, materializeInheritedAttachment } from "../attachmentStore.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** Why an artifact cannot be handed over. `detail` is written for the agent. */
export class ArtifactHandoffError extends Data.TaggedError("ArtifactHandoffError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const refuse = (detail: string) => Effect.fail(new ArtifactHandoffError({ detail }));

/** One artifact of a thread: the stored attachment and the message that carries it. */
export interface ThreadArtifactSource {
  readonly messageId: MessageId;
  readonly attachment: ChatImageAttachment | ChatFileAttachment;
}

/**
 * The artifacts `artifactIds` name in `threadId`, in the given order: each must be one of that
 * thread's own artifacts, at most one message's worth in count and bytes.
 */
export const resolveThreadArtifacts = (
  projections: Pick<ProjectionSnapshotQueryShape, "getThreadMessageById">,
  threadId: ThreadId,
  artifactIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ThreadArtifactSource>, ArtifactHandoffError> =>
  Effect.gen(function* () {
    const ids = [...new Set(artifactIds)];
    if (ids.length === 0) return [];
    if (ids.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
      return yield* refuse(
        `At most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} artifacts can be handed over at once.`,
      );
    const read = projections.getThreadMessageById;
    if (!read) return yield* refuse("Artifact handover is unavailable on this server.");
    const resolved: ThreadArtifactSource[] = [];
    for (const id of ids) {
      const ref = parseThreadArtifactId(id);
      if (ref === null)
        return yield* refuse(`'${id}' is not an artifact id. Use ids from ryco_list_artifacts.`);
      const message = yield* read({ threadId, messageId: MessageId.make(ref.messageId) }).pipe(
        Effect.mapError(
          () => new ArtifactHandoffError({ detail: "This thread's artifacts could not be read." }),
        ),
      );
      const attachment = Option.getOrUndefined(message)?.attachments?.find(
        (candidate) => candidate.id === ref.attachmentId,
      );
      if (
        Option.isNone(message) ||
        attachment === undefined ||
        !isPersistableChatAttachment(attachment) ||
        !isThreadArtifactAttachment(message.value.role, attachment)
      )
        return yield* refuse(
          `Artifact '${id}' is not one of this thread's artifacts (it may have been reverted). Use ids from ryco_list_artifacts.`,
        );
      resolved.push({ messageId: message.value.id, attachment });
    }
    const totalBytes = resolved.reduce((total, entry) => total + entry.attachment.sizeBytes, 0);
    if (totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES)
      return yield* refuse("The artifacts exceed the 50 MiB one message can carry.");
    return resolved;
  });

/**
 * Copies artifacts of `sourceThreadId` into `targetThreadId` and returns the copies, marked as
 * handed over from their source message. Idempotent: a retry links the same copy ids again.
 */
export const copyArtifactsToThread = (input: {
  readonly attachmentsDir: string;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly artifacts: ReadonlyArray<ThreadArtifactSource>;
}): Effect.Effect<ReadonlyArray<ChatAttachment>, ArtifactHandoffError> =>
  Effect.forEach(input.artifacts, (artifact) =>
    Effect.tryPromise({
      try: () =>
        materializeInheritedAttachment({
          attachmentsDir: input.attachmentsDir,
          forkThreadId: input.targetThreadId,
          attachment: artifact.attachment,
        }),
      catch: () =>
        new ArtifactHandoffError({
          detail: `Artifact '${artifact.attachment.name}' could not be copied.`,
        }),
    }).pipe(
      Effect.flatMap(({ attachment }) =>
        isPersistableChatAttachment(attachment)
          ? Effect.succeed<ChatAttachment>({
              ...attachment,
              handoff: { threadId: input.sourceThreadId, messageId: artifact.messageId },
            })
          : refuse(`Artifact '${artifact.attachment.name}' could not be copied.`),
      ),
    ),
  );
