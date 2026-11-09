/**
 * A webhook schedule's hook, in the detail (`docs/automation-webhooks.md`,
 * "For the user"): the Cloud and direct URLs, the secret (hidden until
 * asked for, with Copy and Regenerate), the last request, and ready-made
 * snippets. The owner reads it from the node (`automationCentre.hook`); it
 * is read again when the panel opens, when the schedule changes or runs,
 * and after a regenerate. Only the dialog's chunk loads it, and it adds no
 * icon or overlay of its own: a shared lucide icon or Base UI part regroups
 * the vendor chunks the chat route loads, so Regenerate asks inline.
 */
import type {
  AgentControlAutomationId,
  AutomationHookView,
  EnvironmentId,
  ProjectId,
} from "@ryco/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../../../../environmentApi";
import { getEnvironmentHttpBaseUrl } from "../../../../environments/runtime/catalog";
import { useEvent } from "../../../../hooks/useEvent";
import { DialogButton } from "../dialogControls";
import { RelativeTime } from "../Ticking";
import {
  hookActionsSnippet,
  hookCloudRow,
  hookCurlSnippet,
  hookDirectUrl,
  hookGithubFields,
  hookOutcomeRefused,
  hookOutcomeWords,
  hookSnippetUrl,
  hookViaWords,
  maskedSecret,
} from "./webhookPanel.logic";

const READ_FAILED = "The webhook couldn't be read.";
const NO_HOOKS = "This device can't show webhooks. Update Ryco on it.";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** "Copy", then "Copied" for a moment; a refused clipboard says so. */
function CopyButton(props: {
  readonly value: string;
  readonly label?: string;
  readonly ariaLabel: string;
  readonly dataAct?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const settle = (next: "copied" | "failed") => {
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <DialogButton
      size="xs"
      tone="quiet"
      ariaLabel={props.ariaLabel}
      dataAct={props.dataAct}
      onAction={() => {
        if (!navigator.clipboard?.writeText) return settle("failed");
        navigator.clipboard.writeText(props.value).then(
          () => settle("copied"),
          () => settle("failed"),
        );
      }}
    >
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy"
            : (props.label ?? "Copy")}
      </span>
    </DialogButton>
  );
}

function Row(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly note?: string | null;
  /** Under the value (an inline confirmation). */
  readonly after?: ReactNode;
  readonly field: string;
}) {
  return (
    <div className="ad-hook-row" data-hook-row={props.field}>
      <dt>{props.label}</dt>
      <dd>
        <div className="ad-hook-v">
          {props.children}
          {props.actions ? <span className="ad-hook-x">{props.actions}</span> : null}
        </div>
        {props.note ? <p className="ad-hook-note">{props.note}</p> : null}
        {props.after}
      </dd>
    </div>
  );
}

function Snippet(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly field: string;
}) {
  return (
    <details className="ad-hook-snip" data-snippet={props.field}>
      <summary>{props.title}</summary>
      <div className="ad-hook-snip-b">{props.children}</div>
    </details>
  );
}

function CodeSnippet(props: { readonly code: string; readonly copyLabel: string }) {
  return (
    <>
      <pre className="ad-hook-code">
        <code>{props.code}</code>
      </pre>
      <div className="ad-hook-snip-x">
        <CopyButton value={props.code} ariaLabel={props.copyLabel} />
      </div>
    </>
  );
}

type HookState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: AutomationHookView }
  | { readonly kind: "failed"; readonly error: string };

export interface WebhookPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly automationId: AgentControlAutomationId;
  /** Changes when the schedule changes or runs: the hook is read again. */
  readonly refreshKey: string;
  /** Why changes are off on this device (a hosted reader's role), or null. */
  readonly lockedReason: string | null;
}

export function WebhookPanel(props: WebhookPanelProps) {
  const { environmentId, projectId, automationId } = props;
  const [state, setState] = useState<HookState>({ kind: "loading" });
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const generation = useRef(0);
  const headingId = useId();
  const confirmId = useId();
  const regenerateRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirming) keepRef.current?.focus({ preventScroll: true });
  }, [confirming]);
  const keep = () => {
    setConfirming(false);
    regenerateRef.current?.focus({ preventScroll: true });
  };

  const call = useEvent(async (action: "read" | "regenerate"): Promise<AutomationHookView> => {
    const hook = readEnvironmentApi(environmentId)?.automationCentre?.hook;
    if (!hook) throw new Error(NO_HOOKS);
    return hook({ projectId, automationId, action });
  });

  const read = useEvent(async () => {
    const epoch = ++generation.current;
    try {
      const view = await call("read");
      if (epoch === generation.current) setState({ kind: "ready", view });
    } catch (cause) {
      if (epoch === generation.current)
        setState({ kind: "failed", error: errorText(cause, READ_FAILED) });
    }
  });

  // The host keys the panel by schedule, so another schedule's hook starts hidden.
  useEffect(() => {
    void read();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new refresh key re-reads the hook
  }, [props.refreshKey, read]);

  const regenerate = useEvent(async () => {
    setConfirming(false);
    regenerateRef.current?.focus({ preventScroll: true });
    setRegenerating(true);
    setRegenerateError(null);
    const epoch = ++generation.current;
    // No `finally`: React Compiler cannot lower it, and the component would lose memoization.
    try {
      const view = await call("regenerate");
      if (epoch === generation.current) setState({ kind: "ready", view });
    } catch (cause) {
      if (epoch === generation.current) {
        setRegenerateError(errorText(cause, "The secret couldn't be regenerated."));
        void read();
      }
    }
    setRegenerating(false);
  });

  const view = state.kind === "ready" ? state.view : null;
  const cloud = view ? hookCloudRow(view) : null;
  const direct = view
    ? hookDirectUrl(getEnvironmentHttpBaseUrl(environmentId), view.directPath)
    : null;
  const snippetUrl = direct ? hookSnippetUrl(cloud, direct) : "";
  const error = state.kind === "failed" ? state.error : regenerateError;

  return (
    <section className="ad-sec ad-hook" aria-labelledby={headingId}>
      <h4 className="ad-sec-h" id={headingId}>
        Webhook
      </h4>
      {state.kind === "loading" ? <p className="ad-muted ad-hook-p">Reading its webhook…</p> : null}
      {error ? (
        <p className="ad-warnline ad-hook-err" role="alert">
          <CircleAlertIcon aria-hidden="true" />
          <span>{error}</span>
          {state.kind === "failed" ? (
            <button
              type="button"
              className="ad-link"
              data-act="hook-retry"
              onClick={() => void read()}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {view && direct ? (
        <>
          <p className="ad-muted ad-hook-p">
            Each call starts one run, with the request body as untrusted input.
          </p>
          <dl className="ad-hook-rows">
            {cloud ? (
              <Row
                field="cloud"
                label="Cloud URL"
                note={cloud.note}
                actions={
                  cloud.url ? <CopyButton value={cloud.url} ariaLabel="Copy the Cloud URL" /> : null
                }
              >
                {cloud.url ? <code className="ad-hook-url">{cloud.url}</code> : null}
              </Row>
            ) : null}
            <Row
              field="direct"
              label="Direct URL"
              note={direct.hint}
              actions={
                direct.url ? (
                  <CopyButton value={direct.url} ariaLabel="Copy the direct URL" />
                ) : null
              }
            >
              <code className="ad-hook-url">{direct.display}</code>
            </Row>
            <Row
              field="secret"
              label="Secret"
              after={
                confirming ? (
                  <div
                    className="ad-hook-confirm"
                    role="group"
                    aria-labelledby={confirmId}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      keep();
                    }}
                  >
                    <p id={confirmId}>
                      Regenerate the secret? The old secret stops working at once.
                    </p>
                    <span className="ad-hook-x">
                      <DialogButton
                        size="xs"
                        tone="primary"
                        dataAct="hook-regenerate-confirm"
                        onAction={() => void regenerate()}
                      >
                        Regenerate secret
                      </DialogButton>
                      <DialogButton
                        ref={keepRef}
                        size="xs"
                        tone="quiet"
                        dataAct="hook-keep"
                        onAction={keep}
                      >
                        Keep it
                      </DialogButton>
                    </span>
                  </div>
                ) : null
              }
              actions={
                <>
                  <DialogButton
                    size="xs"
                    tone="quiet"
                    dataAct="hook-show"
                    ariaLabel={shown ? "Hide the secret" : "Show the secret"}
                    onAction={() => setShown((current) => !current)}
                  >
                    {shown ? "Hide" : "Show"}
                  </DialogButton>
                  <CopyButton
                    value={view.secret}
                    ariaLabel="Copy the secret"
                    dataAct="hook-copy-secret"
                  />
                  <DialogButton
                    ref={regenerateRef}
                    size="xs"
                    tone="quiet"
                    dataAct="hook-regenerate"
                    offReason={props.lockedReason}
                    off={regenerating || confirming}
                    onAction={() => setConfirming(true)}
                  >
                    {regenerating ? "Regenerating…" : "Regenerate"}
                  </DialogButton>
                </>
              }
            >
              <code
                className="ad-hook-url ad-hook-secret"
                aria-label={shown ? undefined : "Hidden"}
              >
                {shown ? view.secret : maskedSecret(view.secret)}
              </code>
            </Row>
            <Row field="last" label="Last request">
              {view.lastRequest ? (
                <span>
                  <span className="tnum">
                    <RelativeTime atMs={Date.parse(view.lastRequest.at)} />
                  </span>
                  <span className="ad-muted"> · {hookViaWords(view.lastRequest.via)} · </span>
                  <span
                    className={
                      hookOutcomeRefused(view.lastRequest.outcome) ? "ad-tone-err" : undefined
                    }
                  >
                    {hookOutcomeWords(view.lastRequest.outcome)}
                  </span>
                </span>
              ) : (
                <span className="ad-muted">None yet</span>
              )}
            </Row>
          </dl>
          <div className="ad-hook-snips">
            <Snippet field="github" title="Add it to a GitHub repository">
              <p className="ad-hook-p">In the repository's Settings, Webhooks, Add webhook:</p>
              <dl className="ad-hook-rows">
                {hookGithubFields(snippetUrl).map((field) => (
                  <Row
                    key={field.label}
                    field={`github-${field.label}`}
                    label={field.label}
                    actions={
                      field.copy === "value" ? (
                        <CopyButton value={field.value} ariaLabel={`Copy the ${field.label}`} />
                      ) : field.copy === "secret" ? (
                        <CopyButton value={view.secret} ariaLabel="Copy the secret" />
                      ) : null
                    }
                  >
                    <span className={field.copy === "value" ? "ad-hook-url" : "ad-muted"}>
                      {field.value}
                    </span>
                  </Row>
                ))}
              </dl>
            </Snippet>
            <Snippet field="curl" title="Test it with curl">
              <p className="ad-hook-p">
                Set <code>RYCO_HOOK_SECRET</code> to the secret first.
              </p>
              <CodeSnippet code={hookCurlSnippet(snippetUrl)} copyLabel="Copy the curl command" />
            </Snippet>
            <Snippet field="actions" title="Call it from GitHub Actions">
              <p className="ad-hook-p">
                Save the secret as the repository secret <code>RYCO_HOOK_SECRET</code>, then add
                this step:
              </p>
              <CodeSnippet
                code={hookActionsSnippet(snippetUrl)}
                copyLabel="Copy the GitHub Actions step"
              />
            </Snippet>
          </div>
        </>
      ) : null}
    </section>
  );
}
