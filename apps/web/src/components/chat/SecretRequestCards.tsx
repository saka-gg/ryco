import {
  SECRET_REQUEST_FIELD_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestCards,
  secretRequestFailureText,
  secretRequestOutcomeText,
  secretRequestPrivacyNote,
  type SecretRequestView,
} from "@ryco/client-runtime/secretRequests";
import {
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ServerConfig,
  type ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { readHostedRpcCapability, useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";

const selectAnswersSecretRequests = (config: ServerConfig | null) =>
  config?.environment.capabilities.secretRequests === true;

/** Expiry is re-read this often, so a card left open past its day closes. */
const EXPIRY_RECHECK_MS = 60_000;

/**
 * The private cards for a thread's unanswered secret requests (`ryco_request_secret`). Loaded
 * only for threads that asked. The typed value stays in the card's own state, goes only into
 * `secrets.answerRequest`, and is cleared once the node took it.
 */
export function SecretRequestCards({
  environmentId,
  threadId,
  activities,
  disabledReason,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  /** Why the connection cannot answer right now, when it cannot. */
  disabledReason: string | null;
}) {
  const nodeSupports = useEnvironmentServerConfigSelector(
    environmentId,
    selectAnswersSecretRequests,
  );
  const capability = useHostedRpcCapability(WS_METHODS.secretsAnswerRequest, environmentId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), EXPIRY_RECHECK_MS);
    return () => clearInterval(timer);
  }, []);
  const requests = secretRequestCards(activities, nowMs);
  if (requests.length === 0) return null;
  const reason = !nodeSupports
    ? "Update this node to answer secret requests."
    : !capability.allowed
      ? (capability.reason ?? "Only the node's owner can answer secret requests.")
      : disabledReason;
  return (
    <>
      {requests.map((request) => (
        <SecretRequestCard
          key={request.requestId}
          environmentId={environmentId}
          threadId={threadId}
          request={request}
          reason={reason}
        />
      ))}
    </>
  );
}

function SecretRequestCard({
  environmentId,
  threadId,
  request,
  reason,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  request: SecretRequestView;
  reason: string | null;
}) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [sending, setSending] = useState<"provide" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"provided" | "declined" | null>(null);
  const locked = reason !== null || sending !== null || outcome !== null;
  const fieldId = `secret-request-${request.requestId}`;

  const submit = (type: "provide" | "decline") => {
    if (locked) return;
    const input = secretRequestAnswerInput(
      threadId,
      request.requestId,
      type === "provide" ? { type, value } : { type },
    );
    if (input === null) return;
    // Re-read at click time, so a stale render cannot get past a role or connection change.
    const capability = readHostedRpcCapability(WS_METHODS.secretsAnswerRequest, environmentId);
    const answer = readEnvironmentApi(environmentId)?.threads?.answerSecretRequest;
    if (!capability.allowed || answer === undefined) {
      setError(capability.reason ?? "This node cannot answer secret requests.");
      return;
    }
    setSending(type);
    setError(null);
    // Promise callbacks rather than try/finally, which the React Compiler cannot lower.
    answer(input).then(
      (result) => {
        setValue("");
        setOutcome(result.status === "provided" ? "provided" : "declined");
        setSending(null);
      },
      (failure: unknown) => {
        setError(secretRequestFailureText(failure));
        setSending(null);
      },
    );
  };

  return (
    <section
      aria-label={`Secret request for ${request.key}`}
      className="mx-auto mb-2 w-full max-w-(--chat-composer-max-width) rounded-lg border border-border bg-background px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span>
          The agent asks for <code className="font-mono">{request.key}</code>
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{request.purpose}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Saved to <code className="font-mono">{request.file}</code> in this thread&apos;s checkout.
      </p>
      {outcome !== null ? (
        <p role="status" className="mt-2 text-sm">
          {secretRequestOutcomeText(request, outcome)}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              id={fieldId}
              type={revealed ? "text" : "password"}
              aria-label={`Value for ${request.key}`}
              placeholder={SECRET_REQUEST_FIELD_PLACEHOLDER}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              disabled={locked}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                // No <form>: the card sits above the composer, whose Enter must not fire.
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                submit("provide");
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            <button
              type="button"
              aria-label={revealed ? "Hide value" : "Show value"}
              aria-pressed={revealed}
              onClick={() => setRevealed((current) => !current)}
              className="rounded-md border border-border p-2 text-muted-foreground"
            >
              {revealed ? (
                <EyeOffIcon aria-hidden className="size-4" />
              ) : (
                <EyeIcon aria-hidden className="size-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{secretRequestPrivacyNote(request.file)}</p>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={locked || value.trim().length === 0}
              onClick={() => submit("provide")}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {sending === "provide" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => submit("decline")}
              className="text-sm text-muted-foreground disabled:opacity-50"
            >
              {sending === "decline" ? "Declining…" : "Decline"}
            </button>
          </div>
        </div>
      )}
      {reason !== null && outcome === null ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {reason}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
