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
export function submitApprovalResponse(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  approvalIdentity?: ApprovalResponseIdentity | undefined;
  decision: ProviderApprovalDecision;
  submit: () => Promise<unknown>;
}): Promise<void> {
  let requests = inFlight.get(input.api);
  if (!requests) {
    requests = new Map();
    inFlight.set(input.api, requests);
  }
  const key = JSON.stringify([
    input.threadId,
    input.requestId,
    input.approvalIdentity?.requestEventId,
    input.approvalIdentity?.runtimeSessionId,
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
