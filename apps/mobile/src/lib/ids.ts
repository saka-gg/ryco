import { CommandId, MessageId, ProjectId, ThreadId } from "@ryco/contracts/base-schemas";
import { WorktreeId } from "@ryco/contracts/worktree";

import { uuidv4 } from "./uuid";

// §3-11: app-local brand minters. Upstream imported these from `~/lib/utils`;
// runtime A exposes only the branded schemas, so we mint here over uuidv4
// (expo-crypto randomUUID).
export const newMessageId = (): MessageId => MessageId.make(uuidv4());
export const newCommandId = (): CommandId => CommandId.make(uuidv4());
export const newProjectId = (): ProjectId => ProjectId.make(uuidv4());
export const newThreadId = (): ThreadId => ThreadId.make(uuidv4());
export const newWorktreeId = (): WorktreeId => WorktreeId.make(`worktree-${uuidv4()}`);
