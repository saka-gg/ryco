import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import {
  USER_ACTION_DECLINE_LABEL,
  USER_ACTION_DONE_LABEL,
  USER_ACTION_OPEN_TAB_LABEL,
  USER_ACTION_REMOTE_VIEW_HINT,
  USER_ACTION_SHOW_LABEL,
  userActionAnswerInput,
  userActionContinueElsewhereHint,
  userActionDoneHint,
  userActionOffersRemoteView,
  userActionOutcomeLine,
  userActionRemoteViewTabId,
  userActionRequestCards,
  userActionRequestFailureText,
  userActionRequestLabel,
  type UserActionRequestView,
} from "@ryco/client-runtime/userActionRequests";
import {
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ServerConfig,
  type ThreadId,
  type UserActionOutcome,
  WS_METHODS,
} from "@ryco/contracts";
import {
  USER_ACTION_HINT_INTERNATIONAL_NOTE,
  userActionRequestHints,
  type UserActionHint,
} from "@ryco/shared/userActionHints";
import { HandIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { NodeBrowserViewerClient } from "~/browser/useBrowserMode";
import { readEnvironmentApi } from "~/environmentApi";
import { readEnvironmentConnection } from "~/environments/runtime";
import { readHostedRpcCapability, useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { usePresentationTier } from "~/hooks/usePresentationTier";
import { preloadableLazy, useLazyComponentReady } from "~/lib/preloadableLazy";

const selectAnswersUserActionRequests = (config: ServerConfig | null) =>
  config?.environment.capabilities.userActionRequests === true;

/** Expiry is re-read this often, so a card left open past its time closes. */
const EXPIRY_RECHECK_MS = 15_000;

/** The handed-off tab's viewer: loads on the first Open tab. */
const LazyHandoffTabViewer = preloadableLazy(() =>
  import("./HandoffTabViewer").then((module) => module.HandoffTabViewer),
);

type NodeBrowserRpc = WsRpcClient["nodeBrowser"];

/** The connection's node-browser client, when it can stream a handed-off tab. */
function readHandoffNodeBrowser(environmentId: EnvironmentId): NodeBrowserRpc | null {
  const nodeBrowser: NodeBrowserRpc | undefined =
    readEnvironmentConnection(environmentId)?.client.nodeBrowser;
  return nodeBrowser?.openHandoffFrameSource !== undefined ? nodeBrowser : null;
}

/**
 * Opens the request's tab or terminal on this client, when it can: the surface's own code (the
 * Browser panel, the terminal drawer) decides. `null` when this client cannot show it, and the
 * card says where to continue instead.
 */
export type UserActionShowHandler = (request: UserActionRequestView) => (() => void) | null;

/**
 * The cards for a thread's pending user action requests (a browser tab or terminal an agent
 * handed to the user). Loaded only for threads that handed something over.
 */
export function UserActionRequestCards({
  environmentId,
  threadId,
  activities,
  disabledReason,
  showHandler,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  /** Why the connection cannot answer right now, when it cannot. */
  disabledReason: string | null;
  showHandler?: UserActionShowHandler | undefined;
}) {
  const nodeSupports = useEnvironmentServerConfigSelector(
    environmentId,
    selectAnswersUserActionRequests,
  );
  const capability = useHostedRpcCapability(WS_METHODS.userActionsAnswerRequest, environmentId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), EXPIRY_RECHECK_MS);
    return () => clearInterval(timer);
  }, []);
  // The web phone tier is frozen: it keeps saying where to continue.
  const phoneTier = usePresentationTier() === "phone";
  const requests = userActionRequestCards(activities, nowMs);
  if (requests.length === 0) return null;
  const hints = userActionRequestHints(activities);
  const reason = !nodeSupports
    ? "Update this node to answer this request."
    : !capability.allowed
      ? (capability.reason ?? "Only the node's owner can answer this request.")
      : disabledReason;
  // Read per render, as the Browser panel reads it: the connection's own object.
  const remoteNodeBrowser = phoneTier ? null : readHandoffNodeBrowser(environmentId);
  return (
    <>
      {requests.map((request) => (
        <UserActionRequestCard
          key={request.requestId}
          environmentId={environmentId}
          threadId={threadId}
          request={request}
          reason={reason}
          show={showHandler?.(request) ?? null}
          hint={hints.get(request.requestId)}
          remoteNodeBrowser={remoteNodeBrowser}
        />
      ))}
    </>
  );
}

function UserActionRequestCard({
  environmentId,
  threadId,
  request,
  reason,
  show,
  hint,
  remoteNodeBrowser,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  request: UserActionRequestView;
  reason: string | null;
  show: (() => void) | null;
  /** Sign-in links and codes the surface found (a terminal's device code). */
  hint: UserActionHint | undefined;
  /** The connection's node-browser client when it can stream a handed-off tab, else null. */
  remoteNodeBrowser: NodeBrowserRpc | null;
}) {
  const [sending, setSending] = useState<"done" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UserActionOutcome | null>(null);
  const [viewing, setViewing] = useState(false);
  const locked = reason !== null || sending !== null || outcome !== null;
  const label = userActionRequestLabel(request);
  // Open tab: a client that cannot show the tab itself views it through the node, owner only.
  const viewerClient = useMemo<NodeBrowserViewerClient | null>(() => {
    const openFrameSource = remoteNodeBrowser?.openHandoffFrameSource;
    return remoteNodeBrowser && openFrameSource ? { ...remoteNodeBrowser, openFrameSource } : null;
  }, [remoteNodeBrowser]);
  const openTab =
    show === null &&
    viewerClient !== null &&
    userActionOffersRemoteView(request, { canAnswer: reason === null });
  // Once open it stays open through a brief disconnect (Done and Won't do lock meanwhile); an
  // answer here or elsewhere (the card unmounts) closes it.
  const viewerOpen =
    viewing && show === null && viewerClient !== null && request.remoteView && outcome === null;
  const viewerReady = useLazyComponentReady(LazyHandoffTabViewer, viewerOpen, {
    onLoadError: () => {
      setViewing(false);
      setError("Could not open the tab. Try again.");
    },
  });

  const submit = (answer: "done" | "declined") => {
    if (locked) return;
    // Re-read at click time, so a stale render cannot get past a role or connection change.
    const capability = readHostedRpcCapability(WS_METHODS.userActionsAnswerRequest, environmentId);
    const send = readEnvironmentApi(environmentId)?.threads?.answerUserActionRequest;
    if (!capability.allowed || send === undefined) {
      setError(capability.reason ?? "This node cannot answer this request.");
      return;
    }
    setSending(answer);
    setError(null);
    // Promise callbacks rather than try/finally, which the React Compiler cannot lower.
    send(userActionAnswerInput(threadId, request.requestId, answer)).then(
      (result) => {
        setOutcome(result.outcome);
        setSending(null);
      },
      (failure: unknown) => {
        setError(userActionRequestFailureText(failure));
        setSending(null);
      },
    );
  };

  return (
    <section
      aria-label={label}
      className="mx-auto mb-2 w-full max-w-(--chat-composer-max-width) rounded-lg border border-border bg-background px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <HandIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap">{request.message}</p>
      {outcome === null && hint !== undefined ? <UserActionHintRows hint={hint} /> : null}
      {outcome !== null ? (
        <p role="status" className="mt-2 text-sm">
          {userActionOutcomeLine(outcome)}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            {show !== null
              ? userActionDoneHint(request.surface)
              : openTab
                ? USER_ACTION_REMOTE_VIEW_HINT
                : userActionContinueElsewhereHint(request.surface)}
          </p>
          <div className="mt-3 flex items-center gap-3">
            {openTab ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setViewing(true);
                }}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                {USER_ACTION_OPEN_TAB_LABEL}
              </button>
            ) : null}
            {show !== null ? (
              <button
                type="button"
                onClick={show}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                {USER_ACTION_SHOW_LABEL}
              </button>
            ) : null}
            <button
              type="button"
              disabled={locked}
              onClick={() => submit("done")}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {sending === "done" ? "Finishing…" : USER_ACTION_DONE_LABEL}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => submit("declined")}
              className="text-sm text-muted-foreground disabled:opacity-50"
            >
              {sending === "declined" ? "Declining…" : USER_ACTION_DECLINE_LABEL}
            </button>
          </div>
        </>
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
      {viewerOpen && viewerReady && viewerClient !== null ? (
        <LazyHandoffTabViewer
          client={viewerClient}
          tabId={userActionRemoteViewTabId(request.requestId)}
          label={label}
          onClose={() => setViewing(false)}
          locked={locked}
          sending={sending}
          onAnswer={submit}
          error={error}
        />
      ) : null}
    </section>
  );
}

/** The links and codes a terminal printed for a sign-in: Open and Copy, so nothing is retyped. */
function UserActionHintRows({ hint }: { hint: UserActionHint }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(
      () => setCopied(code),
      () => setCopied(null),
    );
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-sm" aria-label="From the terminal">
      {hint.codes.map((code) => (
        <div key={`code-${code}`} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Code</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono tracking-wider">{code}</code>
          <button
            type="button"
            onClick={() => copy(code)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {copied === code ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
      {hint.links.map((link) => (
        // The real host first and plain (as the node parsed it): the printed link can dress
        // another host up.
        <div key={`link-${link.url}`} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Link to</span>
            <span className="font-medium">{link.host}</span>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
            >
              Open
            </a>
          </div>
          {link.international ? (
            <span role="note" className="text-xs text-warning">
              {USER_ACTION_HINT_INTERNATIONAL_NOTE}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {link.url}
          </span>
        </div>
      ))}
    </div>
  );
}
