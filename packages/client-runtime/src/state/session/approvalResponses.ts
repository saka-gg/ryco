import type {
  ApprovalResponseIdentity,
  EnvironmentApi,
  ProviderApprovalDecision,
  ThreadId,
  ApprovalRequestId,
} from "@ryco/contracts";

// Per environment transport: never share a response between servers, threads or callbacks.
const inFlight = new WeakMap<EnvironmentApi, Map<string, Promise<void>>>();

/** UI reentrancy guard only. Durable claim/retry/settlement authority stays on the server. */
function submitCallbackResponse(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  identity?: ApprovalResponseIdentity | undefined;
  kind: "approval" | "user-input";
  submit: () => Promise<unknown>;
}): Promise<void> {
  let requests = inFlight.get(input.api);
  if (!requests) {
    requests = new Map();
    inFlight.set(input.api, requests);
  }
  const key = JSON.stringify([
    input.kind,
    input.threadId,
    input.requestId,
    input.identity?.requestEventId,
    input.identity?.runtimeSessionId,
  ]);
  const existing = requests.get(key);
  if (existing) return existing;
  // Defer the callback until the synchronous claim is installed.
  const pending = Promise.resolve()
    .then(input.submit)
    .then(() => undefined)
    .finally(() => {
      if (requests.get(key) === pending) requests.delete(key);
    });
  requests.set(key, pending);
  return pending;
}

export function submitApprovalResponse(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  approvalIdentity?: ApprovalResponseIdentity | undefined;
  decision: ProviderApprovalDecision;
  submit: () => Promise<unknown>;
}): Promise<void> {
  return submitCallbackResponse({ ...input, identity: input.approvalIdentity, kind: "approval" });
}

export function submitUserInputResponse(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  userInputIdentity?: ApprovalResponseIdentity | undefined;
  submit: () => Promise<unknown>;
}): Promise<void> {
  return submitCallbackResponse({
    ...input,
    identity: input.userInputIdentity,
    kind: "user-input",
  });
}
