import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  AgentTokenMode,
  UploadChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@ryco/contracts";
import type { KVService } from "../../platform/index.ts";
import { inProcessBatchLaunchLock } from "./batchLaunch.ts";

// Draft bytes live separately from the small launch ledger. Inline images are
// durable context, not expiring upload tokens or temporary platform preview URIs.
const SourceDraft = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  prompt: Schema.String,
  projectCwd: Schema.String,
  baseBranch: Schema.String,
  selections: Schema.Array(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: AgentTokenMode,
  attachments: Schema.Array(UploadChatImageAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
});
export type BatchSourceDraft = typeof SourceDraft.Type;
export interface BatchSourceResetSnapshot {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly sourceId: string | undefined;
  readonly prompt: string;
  readonly attachments: readonly unknown[];
  readonly selections: readonly ModelSelection[];
}

/** Clear only the source the user released, preserving edits made during cleanup. */
export async function completeBatchSourceReset(
  snapshot: BatchSourceResetSnapshot,
  ports: {
    releaseSource: () => Promise<boolean>;
    removeSource: () => Promise<void>;
    readCurrent: () => BatchSourceResetSnapshot;
    clearSource: () => void;
  },
): Promise<boolean> {
  if (!(await ports.releaseSource())) throw new Error("Finish or cancel comparison targets first.");
  await ports.removeSource();
  const current = ports.readCurrent();
  if (
    current.environmentId !== snapshot.environmentId ||
    current.projectId !== snapshot.projectId ||
    current.sourceId !== snapshot.sourceId ||
    current.prompt !== snapshot.prompt ||
    current.attachments !== snapshot.attachments ||
    current.selections !== snapshot.selections
  )
    return false;
  ports.clearSource();
  return true;
}
const MAX_BYTES = 32 * 1024 * 1024;
export function createBatchSourceDraftStore(
  storage: KVService,
  recovery: {
    isSourceReleased: (
      source: Pick<BatchSourceDraft, "id" | "environmentId" | "projectId">,
    ) => Promise<boolean>;
    newSourceId: () => string;
  },
) {
  const key = (environmentId: EnvironmentId, projectId: ProjectId) =>
    `ryco:batch-source:v1:${environmentId}:${projectId}`;
  const lock = inProcessBatchLaunchLock(storage);
  const loadStored = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    const raw = await storage.getItem(key(environmentId, projectId));
    if (!raw) return null;
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
      throw new Error("Saved comparison draft exceeds its storage limit.");
    const draft = Schema.decodeUnknownSync(SourceDraft)(JSON.parse(raw));
    if (
      draft.attachments.some((image) => !image.dataUrl.startsWith(`data:${image.mimeType};base64,`))
    )
      throw new Error("Saved image context must contain durable inline image bytes.");
    if (draft.environmentId !== environmentId || draft.projectId !== projectId)
      throw new Error("Saved draft belongs to another workspace.");
    return draft;
  };
  const load = (environmentId: EnvironmentId, projectId: ProjectId) =>
    lock.exclusive(key(environmentId, projectId), async () => {
      const draft = await loadStored(environmentId, projectId);
      return draft && !(await recovery.isSourceReleased(draft)) ? draft : null;
    });
  return {
    load,
    claim: (draft: BatchSourceDraft) =>
      lock.exclusive(key(draft.environmentId, draft.projectId), async () => {
        const existing = await loadStored(draft.environmentId, draft.projectId);
        if (existing && !(await recovery.isSourceReleased(existing))) return existing;
        // An in-memory composer can also retain the old ID when deletion failed.
        // Replace the source in one durable write; recovery never depends on delete.
        const released = await recovery.isSourceReleased(draft);
        const id = released ? recovery.newSourceId() : draft.id;
        if (!id || (released && id === draft.id))
          throw new Error("A new comparison requires a fresh source ID.");
        const validated = Schema.decodeUnknownSync(SourceDraft)({ ...draft, id });
        if (
          validated.attachments.some(
            (image) => !image.dataUrl.startsWith(`data:${image.mimeType};base64,`),
          )
        )
          throw new Error("Comparison images require durable inline image bytes.");
        const raw = JSON.stringify(validated);
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
          throw new Error("Comparison context exceeds its draft storage limit.");
        await storage.setItem(key(draft.environmentId, draft.projectId), raw);
        return validated;
      }),
    remove: (draft: BatchSourceDraft) =>
      lock.exclusive(key(draft.environmentId, draft.projectId), async () => {
        const existing = await loadStored(draft.environmentId, draft.projectId);
        if (existing?.id === draft.id)
          await storage.removeItem(key(draft.environmentId, draft.projectId));
      }),
  };
}
