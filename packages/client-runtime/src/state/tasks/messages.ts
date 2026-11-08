import { isTagged } from "effect/Predicate";

import type { LocalTaskWriteOperation } from "./writes.ts";

/** The node's own words for a task error; transport text never reaches the user. */
export function localTaskErrorMessage(cause: unknown, fallback: string): string {
  const message = isTagged(cause, "LocalTaskError")
    ? (cause as { message?: unknown }).message
    : undefined;
  return typeof message === "string" && message ? message : fallback;
}

/** What a failed, rolled-back task write says it could not do. */
export function localTaskWriteFailureTitle(operation: LocalTaskWriteOperation): string {
  switch (operation.kind) {
    case "create":
      return "Couldn’t add the task";
    case "update":
      return "Couldn’t save the task";
    case "remove":
      return "Couldn’t delete the task";
    case "addFile":
      return `Couldn’t add ${operation.name}`;
    case "removeFile":
      return "Couldn’t remove the file";
  }
}

/** What a failed write says when the node gave no reason of its own. */
export const LOCAL_TASK_WRITE_FAILED_FALLBACK =
  "The node didn’t confirm the change. It was undone.";
