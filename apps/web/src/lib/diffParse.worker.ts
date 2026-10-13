import { getRenderablePatch } from "./diffParsing";
import type { DiffParseWorkerRequest, DiffParseWorkerResponse } from "./diffParseOffThread";

/**
 * The dedicated worker scope, typed locally: referencing the `webworker` lib
 * here would change the DOM globals of the whole web project.
 */
const workerScope = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<DiffParseWorkerRequest>) => void,
  ) => void;
  postMessage: (message: DiffParseWorkerResponse) => void;
};

const answer = (response: DiffParseWorkerResponse) =>
  // A dedicated worker answers its own page; its postMessage takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  workerScope.postMessage(response);

/**
 * Parses large patches away from the main thread. The result is a plain,
 * structured-cloneable `RenderablePatch`; anything that cannot be sent back is
 * reported so the page parses it itself.
 */
workerScope.addEventListener("message", (event) => {
  const { id, patch, scope } = event.data;
  try {
    answer({ id, ok: true, patch: getRenderablePatch(patch, scope) });
  } catch {
    answer({ id, ok: false });
  }
});
