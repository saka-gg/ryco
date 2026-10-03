import { CopyIcon, QrCodeIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  NodeE2eeAuthorizationRequest,
  NodeE2eeClientListing,
  NodeE2eeClientRecord,
  NodeE2eeContinuity,
  NodeE2eeCrossDeviceApproval,
  NodeE2eeFallback,
  NodeE2eePolicy,
  NodeE2eePolicyChange,
  NodeE2eePolicyProposal,
  NodeE2eePrekey,
  NodeE2eeSessionList,
} from "@ryco/client-runtime/connection";

import { isHostedHubMode } from "../../env";
import {
  createVisibilityAwarePoller,
  type VisibilityAwarePoller,
} from "../../lib/visibilityPolling";
import { webAppLifecycle } from "../../platform/appLifecycle";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSettingsTarget } from "../../settingsTarget";
import { deriveHostedConnectionStatusIndicator } from "../../hostedHub/connectionStatus";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  useWebE2eeChannelStatus,
  useWebE2eeVerificationCode,
} from "../../hostedHub/useWebE2eeSession";
import {
  applyNodeE2eeAuthorization,
  applyNodeE2eeContinuity,
  applyNodeE2eePolicy,
  clearNodeE2eeRefusals,
  createNodeE2eeClientApprovalQr,
  fetchHubEnrollment,
  fetchNodeE2eeClients,
  fetchNodeE2eeContinuity,
  fetchNodeE2eeFallback,
  fetchNodeE2eePolicy,
  fetchNodeE2eePrekey,
  fetchNodeE2eeSessions,
  fetchSessionState,
  previewNodeE2eePolicy,
  recoverNodeE2eePolicyGeneration,
  resetNodeE2eeFallback,
  rotateNodeE2eePrekey,
  setNodeE2eePairingWindow,
} from "~/environments/primary";
import {
  E2EE_WEB_SAS_UNAVAILABLE,
  hostedE2eeVerificationView,
} from "../hostedHub/HostedE2eeVerification.logic";
import { HostedRelayTrustNotice } from "../hostedHub/HostedRelayTrustNotice";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsToolbar,
} from "./settingsLayout";
import { cn } from "../../lib/utils";
import {
  nodeApproveConfirmation,
  nodeClientListingNotices,
  nodeClientRows,
  nodeClientRowTitle,
  nodeClientStatusTone,
  nodeConnectionStatement,
  nodeContinuityRemedy,
  nodeContinuityRows,
  nodeE2eeActionConfirmation,
  nodeE2eePairingWindowConfirmation,
  nodeE2eePolicyGate,
  nodeE2eeRecordConfirmation,
  nodeE2eeStrictPolicyDisposition,
  nodeEnrollmentFingerprintView,
  nodeFallbackReport,
  nodeOperatorDataAvailability,
  nodePairingWindowRows,
  nodePolicyChangeDestructive,
  nodePolicyChangeSummary,
  nodePolicyPreviewWarnings,
  nodePolicyRows,
  nodePrekeyRemedy,
  nodePrekeyRows,
  nodeRefusedAttemptsDescription,
  nodeSafetyNumberView,
  nodeSecurityMode,
  nodeSessionRows,
  nodeSessionVerificationView,
  type NodeE2eeActionConfirmation,
  type NodeE2eeActionId,
  type NodeE2eeApprovableRole,
  type NodeE2eeRecordActionId,
  type NodeE2eeRecordSubject,
  type NodeE2eeStrictPolicyDisposition,
  type NodeLocalOperatorAccess,
  type NodeFactRow,
  NODE_CONTINUITY_DESCRIPTION,
  NODE_E2EE_APPROVABLE_ROLES,
  NODE_E2EE_APPROVAL_CAPABILITY_SET,
  NODE_FALLBACK_QUIET,
  NODE_NO_CLIENTS_DESCRIPTION,
  NODE_NO_SESSIONS_DESCRIPTION,
  NODE_PAIRING_WINDOW_DESCRIPTION,
  NODE_PANEL_SUBTITLE,
  NODE_POLICY_GENERATION_DESCRIPTION,
  NODE_POLICY_REQUIRE_E2EE_DESCRIPTION,
  NODE_POLICY_REQUIRE_E2EE_TITLE,
  NODE_POLICY_STRICT_DESCRIPTION,
  NODE_POLICY_STRICT_TITLE,
  NODE_POLICY_VALUE_UNREADABLE,
  NODE_PREKEY_DESCRIPTION,
  NODE_SAFETY_NUMBER_UNAVAILABLE,
  NODE_SESSION_NATIVE_CODE_ABSENT,
  NODE_SESSION_WEB_ROW_DESCRIPTION,
  NODE_SESSION_WEB_SAS_UNAVAILABLE,
} from "./NodeSecuritySettings.logic";

/**
 * The node's E2EE operator surface, as a panel.
 *
 * A UI OVER A COMPLETE API, and over nothing else. Every value below comes from
 * the sixteen `/api/hub/e2ee/…` routes the node already serves — the same data
 * `ryco e2ee` prints — plus the §13 projection this tab already keeps for its own
 * channel. There is no endpoint, schema, or server behaviour added for it.
 *
 * EVERY DECISION IS IN `NodeSecuritySettings.logic.ts`. This file lays out what
 * that module returns and wires buttons to it; nothing here decides what an owner
 * is told, which mode they are in, or whether an action may run.
 *
 * Matches `HubSection`'s cadence: one poll for every state, and the last good
 * snapshot is kept while an error is shown rather than blanked — a panel that
 * empties on a transient failure reads as "no clients are authorized", which is
 * the one wrong answer this data has.
 */
const POLL_INTERVAL_MS = 5_000;
/** The ceiling the back-off below climbs to while reads keep failing. */
const POLL_MAX_INTERVAL_MS = 60_000;

interface NodeSecuritySnapshot {
  readonly clients: NodeE2eeClientListing | null;
  readonly sessions: NodeE2eeSessionList | null;
  readonly policy: NodeE2eePolicy | null;
  readonly prekey: NodeE2eePrekey | null;
  readonly continuity: NodeE2eeContinuity | null;
  readonly fallback: NodeE2eeFallback | null;
  readonly enrollmentFingerprint: string | null;
}

const EMPTY_SNAPSHOT: NodeSecuritySnapshot = {
  clients: null,
  sessions: null,
  policy: null,
  prekey: null,
  continuity: null,
  fallback: null,
  enrollmentFingerprint: null,
};

function FactRows({ rows }: { readonly rows: ReadonlyArray<NodeFactRow> }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
          <dd
            className={
              row.mono
                ? "min-w-0 font-mono text-[12px] break-all text-foreground"
                : "min-w-0 text-[12px] text-foreground"
            }
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * docs/relay-e2ee-protocol.md §13.4's value, and never the digits alone.
 *
 * The view is one object carrying the number, its format caption, and what a
 * comparison is worth; drawing the number without the sentence takes deleting a
 * field here rather than forgetting a call. Nothing about it is written down:
 * there is no copy button, no `title`, and no form control whose value a browser
 * could restore — §13.4 makes it display-only.
 */
function SafetyNumber({ value }: { readonly value: string }) {
  const view = nodeSafetyNumberView(value);
  if (!view) {
    return (
      <p
        data-testid="node-safety-number"
        data-value="absent"
        className="text-[11px] text-muted-foreground"
      >
        {NODE_SAFETY_NUMBER_UNAVAILABLE}
      </p>
    );
  }
  return (
    <div data-testid="node-safety-number" data-value="present" className="space-y-1.5">
      <p className="text-[11px] font-medium">Comparison number</p>
      {/* Monospace and selectable as a whole: the comparison is digit by digit,
          so a proportional face costs the reader the only check §13.4 gives. */}
      <p
        data-testid="node-safety-number-value"
        className="font-mono text-[13px] leading-relaxed font-semibold tracking-[0.08em] select-all"
      >
        {view.display}
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{view.caption}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{view.advisory}</p>
    </div>
  );
}

/**
 * §13.5's characters, with whatever advisory came in the same object.
 *
 * It cannot be handed a code and an advisory separately — there is one argument,
 * and it is a view whose `advisory` is a required field. Which advisory that is
 * belongs to the caller's END of the comparison, and the two callers below are
 * the only ones: each is wired to exactly one view builder, so the referent is
 * structural rather than a parameter someone can pass the wrong way round.
 *
 * `more` IS REQUIRED AND NULLABLE RATHER THAN OPTIONAL, which is the difference
 * between a fact and a convention. The node end genuinely has no second sentence
 * — its reader is already on the page a pointer would name — but written `more?:
 * string` that absence was indistinguishable from a caller who forgot the field,
 * and forgetting it on the browser end drops the sentence naming
 * `ryco e2ee sessions`: the page the node menu's pointer leads to would show a
 * value to compare and no way to obtain the thing to compare it against. `null`
 * makes "this end has no second sentence" something a view STATES, and omitting
 * it a compile error.
 */
function VerificationCode({
  view,
  unavailable,
  testId,
}: {
  readonly view: {
    readonly display: string;
    readonly advisory: string;
    readonly more: string | null;
  } | null;
  readonly unavailable: string;
  readonly testId: string;
}) {
  if (!view) {
    return (
      <p data-testid={testId} data-code="absent" className="text-[11px] text-muted-foreground">
        {unavailable}
      </p>
    );
  }
  return (
    <div data-testid={testId} data-code="present" className="space-y-1.5">
      <p
        data-testid={`${testId}-value`}
        className="font-mono text-sm leading-none font-semibold tracking-[0.2em] whitespace-nowrap select-all"
      >
        {view.display}
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{view.advisory}</p>
      {view.more === null ? null : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{view.more}</p>
      )}
    </div>
  );
}

/**
 * §13.5 for THIS TAB'S OWN channel, through the shipped inseparable value.
 *
 * The shipped advisory is written from the browser end — "compare this code with
 * the one your node's CLI shows" — and this is the one site in this panel where
 * the reader is at the browser end, so it is correct here and nowhere else.
 *
 * IT TAKES THE `settings` LENGTH, WHICH IS THIS PANEL'S WHOLE JOB HERE. The
 * connection surface draws the one line §13.5 requires and points at this page
 * for the rest; this is that page, so drawing the same short line would make the
 * pointer circular and leave §2.2's second reason — that this tab pins no node
 * identity — stated nowhere the pointer led.
 */
function OwnChannelVerificationCode({ code }: { readonly code: string | null }) {
  return (
    <VerificationCode
      view={hostedE2eeVerificationView(code, "settings")}
      unavailable={E2EE_WEB_SAS_UNAVAILABLE}
      testId="node-session-code"
    />
  );
}

/**
 * §13.5 for a session on the NODE'S list, through the node-end view.
 *
 * The reader here is at the node. Rendering the browser-end advisory would tell
 * them to compare the node's code against the node's own CLI — a comparison that
 * always matches and establishes nothing — so the node end has its own sentence,
 * with §13.5's denial restated in node-end terms.
 */
function NodeSessionVerificationCode({ code }: { readonly code: string | null }) {
  return (
    <VerificationCode
      view={nodeSessionVerificationView(code)}
      unavailable={NODE_SESSION_WEB_SAS_UNAVAILABLE}
      testId="node-session-code"
    />
  );
}

/**
 * Panel 6 — HOSTED ONLY, and absent rather than empty in local mode.
 *
 * There is no relay in local mode, so there is no channel to describe. Rendering
 * this section there with an "unavailable" channel would invite a reader to
 * treat the absence of relay encryption as a finding, which is exactly the
 * indicator this panel must not train them to ignore.
 *
 * The claim itself is the shipped selector's, keyed on the live §4.4 projection,
 * so this surface cannot make a claim the channel has outgrown or one it has not
 * earned.
 */
function ThisConnectionSection() {
  const channelStatus = useWebE2eeChannelStatus();
  const code = useWebE2eeVerificationCode();
  const browserStatus = useHostedHubStore((state) => state.browserStatus);
  const sessionStatus = useHostedHubStore((state) => state.sessionStatus);
  const selectionStatus = useHostedHubStore((state) => state.selectionStatus);
  const transportStatus = useHostedHubStore((state) => state.transportStatus);
  const indicator = deriveHostedConnectionStatusIndicator({
    browserStatus,
    sessionStatus,
    selectionStatus,
    transportStatus,
    e2eeStatus: channelStatus,
  });
  const statement = nodeConnectionStatement("hosted", indicator);

  return (
    <SettingsSection title="This connection">
      <SettingsRow
        title={statement.headline}
        description={statement.body}
        status={
          // The word comes from the shared derivation's bounded vocabulary. No
          // status noun is invented here, and none is derived a second time.
          <Badge
            size="sm"
            variant={
              indicator.guarantee === "e2ee"
                ? "success"
                : indicator.guarantee === "web"
                  ? "info"
                  : indicator.guarantee === "legacy"
                    ? "warning"
                    : "outline"
            }
            data-testid="node-connection-claim"
          >
            {indicator.shortLabel}
          </Badge>
        }
      >
        <div className="space-y-3 pb-3.5">
          {/* THE SHIPPED COMPONENT, AS ITS SIXTH MOUNT SITE. Deriving the
              disclosure here and drawing only `.body` dropped the `tone` the
              component exists to carry, so §12.2's legacy-fallback disclosure
              rendered in the same muted grey as the advisory one — the single
              presentational signal that separates "the Hub can read this" from
              "the Hub relays ciphertext", gone at the panel about security. It
              reads the §4.4 projection itself, so nothing is passed to it and
              nothing here can pass it a stale one. */}
          <HostedRelayTrustNotice />
          {channelStatus === "web-unsigned" ? <OwnChannelVerificationCode code={code} /> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * A confirmation waiting on the owner.
 *
 * It carries the RESOLVED copy rather than an action id, because an approval's
 * copy depends on the role the owner picked — and a dialog that looked its copy
 * up from an id could not name that role in the sentence the owner is agreeing
 * to.
 */
interface PendingConfirmation {
  readonly copy: NodeE2eeActionConfirmation;
  readonly run: () => Promise<void>;
}

function PrimaryNodeSecuritySettings() {
  const mode = nodeSecurityMode(isHostedHubMode());
  const desktopOwner = typeof window !== "undefined" && window.desktopBridge != null;
  const [localOperatorAccess, setLocalOperatorAccess] = useState<NodeLocalOperatorAccess>(() =>
    desktopOwner ? "owner" : "checking",
  );
  const availability = nodeOperatorDataAvailability(mode, localOperatorAccess);
  const strictPolicy = nodeE2eeStrictPolicyDisposition(mode);

  const [snapshot, setSnapshot] = useState<NodeSecuritySnapshot>(EMPTY_SNAPSHOT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    readonly proposal: NodeE2eePolicyProposal;
    readonly warnings: ReadonlyArray<string>;
    readonly destructive: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [approvalQr, setApprovalQr] = useState<{
    readonly approval: NodeE2eeCrossDeviceApproval;
    readonly label: string;
  } | null>(null);
  const [windowFingerprint, setWindowFingerprint] = useState("");
  const mountedRef = useRef(true);
  const failuresRef = useRef(0);
  const pollerRef = useRef<VisibilityAwarePoller | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "local" || desktopOwner) return;

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setLocalOperatorAccess(
          session.authenticated && session.role === "owner" ? "owner" : "client",
        );
      })
      .catch(() => {
        if (!cancelled) setLocalOperatorAccess("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [desktopOwner, mode]);

  const refresh = useCallback(async () => {
    if (!availability.available) return;
    try {
      const [clients, sessions, policy, prekey, continuity, fallback] = await Promise.all([
        fetchNodeE2eeClients(),
        fetchNodeE2eeSessions(),
        fetchNodeE2eePolicy(),
        fetchNodeE2eePrekey(),
        fetchNodeE2eeContinuity(),
        fetchNodeE2eeFallback(),
      ]);
      // 404 is the normal answer once a ceremony is over, and the helper already
      // returns null for it rather than throwing.
      const enrollment = await fetchHubEnrollment().catch(() => null);
      if (!mountedRef.current) return;
      failuresRef.current = 0;
      setSnapshot({
        clients,
        sessions,
        policy,
        prekey,
        continuity,
        fallback,
        enrollmentFingerprint: enrollment?.fingerprint ?? null,
      });
      setError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      failuresRef.current += 1;
      // The last good snapshot stays on screen: blanking the client list on a
      // transient read failure would read as "nothing is authorized".
      setError(
        cause instanceof Error ? cause.message : "Unable to read the node's security state.",
      );
    }
  }, [availability.available]);

  /**
   * The poll, WITH A CEILING ON HOW OFTEN IT RETRIES A FAILURE.
   *
   * These six routes are owner-only, and a session that is not the owner's gets
   * 403 from every one of them for as long as it holds the panel open. A flat
   * five-second interval re-issued all six forever against a refusal that cannot
   * start succeeding — the first unconditioned polling loop of its kind in this
   * client. Backing off on consecutive failures keeps the recovery from a
   * transient outage (the first retry is still five seconds later) while bounding
   * what a permanent one costs.
   */
  useEffect(() => {
    if (!availability.available) return;
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: refresh,
      resolveDelayMs: () =>
        Math.min(
          POLL_INTERVAL_MS * 2 ** Math.max(0, failuresRef.current - 1),
          POLL_MAX_INTERVAL_MS,
        ),
      jitterRatio: 0.1,
    });
    pollerRef.current = poller;
    return () => {
      if (pollerRef.current === poller) pollerRef.current = null;
      poller.stop();
    };
  }, [availability.available, refresh]);

  const refreshCurrent = useCallback(() => pollerRef.current?.refresh() ?? refresh(), [refresh]);

  /**
   * Every mutation goes through here, so none of them can skip the refresh.
   *
   * THE OPERATION MAY OWN ITS OWN NOTICE, and RETURNING A STRING is how it does.
   * `run` used to write `message` unconditionally after awaiting — in the same
   * synchronous continuation the operation had just written its own notice in —
   * so §12.6(c)'s post-change report was built and then discarded a line later,
   * and a change that closed twelve channels and aborted three handshakes
   * reported the same three words as one that touched nothing. Every node client
   * call resolves to a record, a listing, or nothing, so a string here is always
   * a deliberate notice and never a leaked response body.
   */
  const run = useCallback(
    async (operation: () => Promise<unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const produced = await operation();
        if (mountedRef.current) setNotice(typeof produced === "string" ? produced : message);
        await refreshCurrent();
      } catch (cause) {
        if (!mountedRef.current) return;
        setError(cause instanceof Error ? cause.message : "That didn't work.");
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [refreshCurrent],
  );

  const confirmThen = useCallback(
    (action: NodeE2eeActionId, operation: () => Promise<unknown>, message: string) => {
      setConfirmation({
        copy: nodeE2eeActionConfirmation(action),
        run: () => run(operation, message),
      });
    },
    [run],
  );

  /** The same gate, for the confirmations that must echo the record they name. */
  const confirmCopyThen = useCallback(
    (copy: NodeE2eeActionConfirmation, operation: () => Promise<unknown>, message: string) => {
      setConfirmation({ copy, run: () => run(operation, message) });
    },
    [run],
  );

  /**
   * §12.6: preview first, always.
   *
   * The preview mutates nothing and is a separate route for exactly this reason,
   * so the panel asks it, shows what comes back, and only then offers to apply.
   * There is no code path from a control to `applyNodeE2eePolicy` that does not
   * pass through the preview state below.
   */
  const startPolicyChange = useCallback(
    async (proposal: NodeE2eePolicyProposal) => {
      const gate = nodeE2eePolicyGate(mode, proposal);
      if (!gate.allowed) {
        setError(gate.refusal);
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const previewed = await previewNodeE2eePolicy(gate.proposal);
        if (!mountedRef.current) return;
        // The warnings and the button's colour are both read against the policy
        // the node currently reports, because §12.6's preview answers with the
        // RESULTING policy — a proposal that relaxes admission comes back
        // reporting the relaxed value either way, so the preview alone cannot
        // tell a widening from a restatement.
        setPreview({
          proposal: gate.proposal,
          warnings: nodePolicyPreviewWarnings(previewed, gate.proposal, snapshot.policy),
          destructive: nodePolicyChangeDestructive(previewed, gate.proposal, snapshot.policy),
        });
      } catch (cause) {
        if (!mountedRef.current) return;
        setError(cause instanceof Error ? cause.message : "Unable to preview that change.");
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [mode, snapshot.policy],
  );

  const applyPreviewedPolicy = useCallback(async () => {
    if (preview === null) return;
    // Gated a second time at the point of application. The proposal has been
    // sitting in state while an operator read a warning, and a guard that ran
    // only where the proposal was built would be a guard on a code path rather
    // than on the request.
    const gate = nodeE2eePolicyGate(mode, preview.proposal);
    if (!gate.allowed) {
      setError(gate.refusal);
      setPreview(null);
      return;
    }
    const proposal = gate.proposal;
    setPreview(null);
    // §12.6(c)'s report is RETURNED rather than written, so `run` cannot
    // overwrite it with the generic message on the next line.
    await run(async () => {
      const change: NodeE2eePolicyChange = await applyNodeE2eePolicy(proposal);
      return nodePolicyChangeSummary(change);
    }, "Policy applied.");
  }, [mode, preview, run]);

  /**
   * §13.6's three per-record withdrawals, whose confirmation echoes the record.
   *
   * The subject is derived from the same request the network gets, so the key
   * named in the dialog and the key in the body cannot disagree.
   */
  const authorize = useCallback(
    (request: NodeE2eeAuthorizationRequest, action: NodeE2eeRecordActionId, message: string) => {
      const subject: NodeE2eeRecordSubject = {
        fingerprint: request.fingerprint,
        accountId: request.accountId,
        hubOrigin: request.hubOrigin,
      };
      confirmCopyThen(
        nodeE2eeRecordConfirmation(action, subject),
        () => applyNodeE2eeAuthorization(request),
        message,
      );
    },
    [confirmCopyThen],
  );

  /** An approval, whose confirmation names the role the owner picked (§13.6). */
  const approve = useCallback(
    (request: NodeE2eeAuthorizationRequest, role: NodeE2eeApprovableRole) => {
      setConfirmation({
        copy: nodeApproveConfirmation(role, {
          fingerprint: request.fingerprint,
          accountId: request.accountId,
          hubOrigin: request.hubOrigin,
        }),
        run: () =>
          run(async () => {
            await applyNodeE2eeAuthorization(request);
            try {
              const approval = await createNodeE2eeClientApprovalQr({
                hubOrigin: request.hubOrigin,
                accountId: request.accountId,
                fingerprint: request.fingerprint,
              });
              if (mountedRef.current) {
                setApprovalQr({ approval, label: request.fingerprint });
              }
              return `Client approved as ${role}. Scan the code on the new device.`;
            } catch {
              // Approval is already durable. Report that truthfully and leave
              // the approved row's retry action available rather than turning
              // a QR rendering failure into a false "approval failed" result.
              return `Client approved as ${role}. The QR code was not created; use Show phone QR to retry.`;
            }
          }, `Client approved as ${role}.`),
      });
    },
    [run],
  );

  const showApprovalQr = useCallback(async (record: NodeE2eeClientRecord) => {
    setBusy(true);
    setError(null);
    try {
      const approval = await createNodeE2eeClientApprovalQr({
        hubOrigin: record.hubOrigin,
        accountId: record.accountId,
        fingerprint: record.fingerprint,
      });
      if (mountedRef.current) {
        setApprovalQr({
          approval,
          label: record.displayLabel ?? record.fingerprint,
        });
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Unable to create the phone QR code.");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const fingerprintView = nodeEnrollmentFingerprintView(snapshot.enrollmentFingerprint);
  const fallback = useMemo(() => nodeFallbackReport(snapshot.fallback), [snapshot.fallback]);
  const listingNotices = nodeClientListingNotices(snapshot.clients);
  const prekeyRemedy = nodePrekeyRemedy(snapshot.prekey);
  const continuityRemedy = nodeContinuityRemedy(snapshot.continuity);
  const activeConfirmation = confirmation?.copy ?? null;
  const canCopy =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  return (
    <SettingsPageContainer>
      <SettingsToolbar
        actions={
          availability.available ? (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => void refreshCurrent()}
            >
              <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              Refresh
            </Button>
          ) : null
        }
      >
        {NODE_PANEL_SUBTITLE}
      </SettingsToolbar>

      {/* `error !== null` rather than truthiness: a refusal that arrived as an
          empty string would otherwise render as no message at all, and a guard
          that fails silently is one operators route around. */}
      {error !== null ? (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertTitle>That didn&apos;t work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="info">
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {/* Panel 6, hosted only. There is no channel in local mode, so there is
          nothing here to describe and no warning to raise about its absence. */}
      {mode === "hosted" ? <ThisConnectionSection /> : null}

      {!availability.available ? (
        <SettingsSection title={mode === "hosted" ? "This node" : "This session"}>
          <SettingsRow
            title={nodeConnectionStatement(mode, null).headline}
            description={availability.unavailableBody}
          />
          {/* `null`, not `false`. Hosted mode never reads the node's policy —
              `refresh()` returns before it asks — so a switch drawn in the off
              position asserted `requireApprovedClientE2EE: false` about a node
              this very section had just said it cannot see. */}
          {mode === "hosted" ? (
            <StrictPolicyRow
              disposition={strictPolicy}
              checked={null}
              busy={busy}
              onChange={(checked) => void startPolicyChange({ requireApprovedClientE2EE: checked })}
            />
          ) : null}
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="This node's identity">
            <SettingsRow
              title="Enrollment fingerprint"
              description={fingerprintView.caption}
              control={
                fingerprintView.fingerprint !== null && canCopy ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => copyToClipboard(fingerprintView.fingerprint!)}
                  >
                    <CopyIcon className="size-3.5" />
                    Copy
                  </Button>
                ) : null
              }
            >
              {fingerprintView.fingerprint !== null ? (
                <p
                  data-testid="node-enrollment-fingerprint"
                  className="pb-3.5 font-mono text-[13px] break-all select-all"
                >
                  {fingerprintView.fingerprint}
                </p>
              ) : null}
            </SettingsRow>
            <SettingsRow
              title="Agreement prekey"
              description={prekeyRemedy ?? NODE_PREKEY_DESCRIPTION}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    confirmThen("rotate-prekey", rotateNodeE2eePrekey, "Prekey rotated.")
                  }
                >
                  Rotate
                </Button>
              }
            >
              <div className="pb-3.5">
                <FactRows rows={nodePrekeyRows(snapshot.prekey)} />
              </div>
            </SettingsRow>
            <SettingsRow
              title="Continuity"
              description={continuityRemedy ?? NODE_CONTINUITY_DESCRIPTION}
              control={
                <>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() =>
                      confirmThen(
                        "break-continuity",
                        () => applyNodeE2eeContinuity({ action: "break" }),
                        "Continuity chain broken.",
                      )
                    }
                  >
                    Break chain
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() =>
                      confirmThen(
                        "remint-continuity",
                        () => applyNodeE2eeContinuity({ action: "remint" }),
                        "Fresh lineage minted.",
                      )
                    }
                  >
                    Mint fresh
                  </Button>
                </>
              }
            >
              <div className="pb-3.5">
                <FactRows rows={nodeContinuityRows(snapshot.continuity)} />
              </div>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Authorized clients">
            {listingNotices.map((message) => (
              <SettingsRow key={message} title="Pairing" description={message} />
            ))}
            <SettingsRow
              title="Pairing window"
              description={NODE_PAIRING_WINDOW_DESCRIPTION}
              control={
                <>
                  <Input
                    value={windowFingerprint}
                    disabled={busy}
                    placeholder="SHA256:…"
                    aria-label="Pairing window fingerprint"
                    className="w-56 font-mono text-xs"
                    onChange={(event) => setWindowFingerprint(event.currentTarget.value)}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || windowFingerprint.trim() === ""}
                    onClick={() =>
                      // The confirmation echoes the trimmed value, because its
                      // own body names a wrong fingerprint as the risk and the
                      // input it was typed into sits behind the dialog's scrim.
                      confirmCopyThen(
                        nodeE2eePairingWindowConfirmation(windowFingerprint.trim()),
                        () =>
                          setNodeE2eePairingWindow({
                            action: "open",
                            fingerprint: windowFingerprint.trim(),
                          }),
                        "Pairing window opened.",
                      )
                    }
                  >
                    Open
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || snapshot.clients?.pairingWindow === undefined}
                    onClick={() =>
                      confirmThen(
                        "close-window",
                        () => setNodeE2eePairingWindow({ action: "close" }),
                        "Pairing window closed.",
                      )
                    }
                  >
                    Close
                  </Button>
                </>
              }
            >
              <div className="pb-3.5">
                <FactRows rows={nodePairingWindowRows(snapshot.clients)} />
              </div>
            </SettingsRow>
            <SettingsRow
              title="Refused attempts"
              description={nodeRefusedAttemptsDescription(snapshot.clients)}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || (snapshot.clients?.refusedPairingAttempts ?? 0) === 0}
                  onClick={() =>
                    confirmThen("clear-refusals", clearNodeE2eeRefusals, "Refusal count cleared.")
                  }
                >
                  Clear
                </Button>
              }
            />
            {(snapshot.clients?.records ?? []).map((record) => (
              <ClientRecordRow
                key={`${record.hubOrigin}\u0000${record.accountId}\u0000${record.fingerprint}`}
                record={record}
                busy={busy}
                onAuthorize={authorize}
                onApprove={approve}
                onShowApprovalQr={showApprovalQr}
              />
            ))}
            {snapshot.clients !== null && snapshot.clients.records.length === 0 ? (
              <SettingsRow
                title="No client keys on file"
                description={NODE_NO_CLIENTS_DESCRIPTION}
              />
            ) : null}
          </SettingsSection>

          <SettingsSection title="Live sessions">
            {(snapshot.sessions?.sessions ?? []).map((session) => (
              <SettingsRow
                key={session.sessionIndex}
                title={`Session ${session.sessionIndex}`}
                // The comparison instruction is NOT here. It lives in the
                // advisory that travels with the characters, and nowhere else:
                // a row description telling the owner to check one screen, one
                // line above an advisory telling them to check another, is how
                // this panel came to contradict itself on §13.5.
                description={
                  session.tier === "native"
                    ? NODE_SESSION_NATIVE_CODE_ABSENT
                    : NODE_SESSION_WEB_ROW_DESCRIPTION
                }
              >
                <div className="space-y-3 pb-3.5">
                  <FactRows rows={nodeSessionRows(session)} />
                  {session.tier === "web" ? (
                    <NodeSessionVerificationCode code={session.verificationCode ?? null} />
                  ) : null}
                </div>
              </SettingsRow>
            ))}
            {snapshot.sessions !== null && snapshot.sessions.sessions.length === 0 ? (
              <SettingsRow title="No sessions" description={NODE_NO_SESSIONS_DESCRIPTION} />
            ) : null}
          </SettingsSection>

          <SettingsSection title="Admission policy">
            {/* Both switches take `null` while the policy has not been read.
                `?? false` drew them in the off position next to
                `nodePolicyRows(null)`'s "Admission policy: unknown" — the two
                disagreeing on screen about the same values. */}
            <PolicySwitchRow
              title={NODE_POLICY_REQUIRE_E2EE_TITLE}
              description={NODE_POLICY_REQUIRE_E2EE_DESCRIPTION}
              checked={snapshot.policy === null ? null : snapshot.policy.requireE2EE}
              busy={busy}
              ariaLabel="Require E2EE"
              testId="require-e2ee"
              onChange={(checked) => void startPolicyChange({ requireE2EE: checked })}
            />
            <StrictPolicyRow
              disposition={strictPolicy}
              checked={snapshot.policy === null ? null : snapshot.policy.requireApprovedClientE2EE}
              busy={busy}
              onChange={(checked) => void startPolicyChange({ requireApprovedClientE2EE: checked })}
            />
            <SettingsRow
              title="Policy generation"
              description={NODE_POLICY_GENERATION_DESCRIPTION}
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() =>
                    confirmThen(
                      "recover-policy",
                      recoverNodeE2eePolicyGeneration,
                      "Policy generation advanced.",
                    )
                  }
                >
                  Advance
                </Button>
              }
            >
              <div className="pb-3.5">
                <FactRows rows={nodePolicyRows(snapshot.policy)} />
              </div>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Fallback">
            {fallback === null ? (
              <SettingsRow title="Fallback" description="Waiting for the node." />
            ) : fallback.quiet ? (
              <SettingsRow
                title="Nothing has fallen back"
                description={NODE_FALLBACK_QUIET}
                control={<ResetFallbackButton busy={busy} onConfirm={confirmThen} />}
              />
            ) : (
              <>
                {fallback.classes.map((entry) => (
                  <SettingsRow
                    key={entry.label}
                    title={entry.label}
                    description={entry.meaning}
                    status={`Last ${entry.lastOccurrence}${entry.ringOverflows > 0 ? ` · ${entry.ringOverflows} overflow(s)` : ""}`}
                    control={
                      <span className="font-mono text-sm font-semibold">{entry.occurrences}</span>
                    }
                  />
                ))}
                <SettingsRow
                  title="Retained occurrences"
                  description={
                    fallback.overflowNotice ??
                    `Observation window started ${fallback.windowStarted}.`
                  }
                  control={<ResetFallbackButton busy={busy} onConfirm={confirmThen} />}
                >
                  <ul className="space-y-1 pb-3.5">
                    {fallback.entries.map((entry) => (
                      <li
                        key={entry.ordinal}
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        {entry.at} · {entry.reason}
                      </li>
                    ))}
                  </ul>
                </SettingsRow>
                {fallback.undersizedNotice ? (
                  <SettingsRow
                    title="Undersized connection"
                    description={fallback.undersizedNotice}
                  />
                ) : null}
              </>
            )}
          </SettingsSection>
        </>
      )}

      {/* §12.6's warning, between the preview and the change. */}
      <AlertDialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply this policy change?</AlertDialogTitle>
            {/* There is no empty branch: `nodePolicyPreviewWarnings` never
                returns an empty list, so the dialog cannot fall back to a
                sentence that reads as "this is safe" for a change that reduces
                what the node enforces. */}
            <AlertDialogDescription>
              {preview?.warnings.map((warning) => (
                <span key={warning} className="block pb-2">
                  {warning}
                </span>
              ))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Leave it</AlertDialogClose>
            <Button
              // Red only when the node will shut live channels or the change
              // reduces what it enforces. Every policy change drawing the same
              // red Apply — including the ones whose own body says they close
              // nothing — trains the click-through that costs an owner the one
              // that strands their access.
              variant={preview?.destructive ? "destructive" : "default"}
              data-testid="policy-apply"
              disabled={busy}
              onClick={() => void applyPreviewedPolicy()}
            >
              Apply
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{activeConfirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{activeConfirmation?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* The record or value this confirmation is about, in the same mono
              face its row uses. The dialog paints an opaque scrim over the list,
              so whatever tells two rows apart has to be inside it. */}
          {activeConfirmation?.facts ? (
            <div data-testid="node-confirmation-facts" className="pb-1">
              <FactRows rows={activeConfirmation.facts} />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={activeConfirmation?.destructive ? "destructive" : "default"}
              data-testid="node-confirmation-confirm"
              disabled={busy}
              onClick={() => {
                const pending = confirmation;
                setConfirmation(null);
                if (pending) void pending.run();
              }}
            >
              {activeConfirmation?.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Dialog open={approvalQr !== null} onOpenChange={(open) => !open && setApprovalQr(null)}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Verify this phone</DialogTitle>
            <DialogDescription>
              On the new phone, open node verification and scan this code. It is bound to that
              phone&apos;s key and expires after five minutes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {approvalQr ? (
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-2xl bg-white p-3">
                  <QRCodeSvg
                    value={approvalQr.approval.payload}
                    size={240}
                    level="M"
                    marginSize={2}
                    title="Node approval — scan with Ryco on the new phone"
                  />
                </div>
                <p className="max-w-full break-all text-center font-mono text-[11px] text-muted-foreground">
                  {approvalQr.label}
                </p>
              </div>
            ) : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              The code contains no secret and grants no access by itself. Ryco will reconnect and
              prove both device keys after the scan.
            </p>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}

export function NodeSecuritySettings() {
  const settingsTarget = useSettingsTarget();
  if (settingsTarget && !settingsTarget.primary) {
    return (
      <SettingsPageContainer>
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Open Security on {settingsTarget.nodeLabel}</AlertTitle>
          <AlertDescription>
            Security administration requires that node&apos;s direct local operator channel. Ryco
            has disabled these controls here so an action can never be applied to this Mac by
            mistake.
          </AlertDescription>
        </Alert>
      </SettingsPageContainer>
    );
  }
  return <PrimaryNodeSecuritySettings />;
}

/**
 * §12.4's control — THE ONE THE HARD BLOCK IS ON — as a single component both
 * modes render.
 *
 * IT WAS TWO CONTROLS AND THAT WAS THE DEFECT. The hosted branch drew its own
 * `<Switch disabled />` with the attribute written by hand, so the block it
 * demonstrated was a literal rather than a consequence of
 * {@link nodeE2eeStrictPolicyDisposition}: deleting the disposition from the
 * local branch left the hosted one disabled anyway, and a suite asserting the
 * hosted control is inert passed while the guard it was supposed to be checking
 * had gone. One component, one `disabled` expression, derived from the
 * disposition — so the assertion and the guard are the same thing.
 *
 * The reason travels as the description rather than as a tooltip: a control an
 * operator cannot use and cannot find out why about is one they will go looking
 * for a way around.
 */
function StrictPolicyRow({
  disposition,
  checked,
  busy,
  onChange,
}: {
  readonly disposition: NodeE2eeStrictPolicyDisposition;
  readonly checked: boolean | null;
  readonly busy: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const blocked = disposition.kind === "blocked";
  return (
    <PolicySwitchRow
      title={NODE_POLICY_STRICT_TITLE}
      description={
        disposition.kind === "blocked" ? disposition.reason : NODE_POLICY_STRICT_DESCRIPTION
      }
      checked={checked}
      busy={busy}
      blocked={blocked}
      ariaLabel="Require approved client E2EE"
      testId="require-approved-client-e2ee"
      onChange={onChange}
    />
  );
}

/**
 * A policy switch that can say it does not know.
 *
 * A DISABLED SWITCH STILL DRAWS IN A POSITION, AND A POSITION IS A CLAIM. Both
 * of these rows used to take `?? false`, so an unread policy rendered as "off" —
 * in hosted mode permanently, because that build never reads the policy at all,
 * and in local mode on first paint and for the whole life of a failing read. An
 * owner who had locked their node with `--require-approved-client-e2ee` opened
 * the hosted panel and read that it was off. Everywhere else this panel states
 * the absence instead (`Admission policy: unknown`, `never`), so the `null` case
 * renders no control at all rather than a control in a position.
 */
function PolicySwitchRow({
  title,
  description,
  checked,
  busy,
  blocked = false,
  ariaLabel,
  testId,
  onChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean | null;
  readonly busy: boolean;
  readonly blocked?: boolean;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      title={title}
      description={
        checked === null ? `${description} ${NODE_POLICY_VALUE_UNREADABLE}` : description
      }
      control={
        checked === null ? (
          // No `aria-label` and no control role: the row title is the name, and
          // an unknown value has nothing for a control to be set to.
          <span
            data-testid={testId}
            data-policy="unknown"
            data-blocked={blocked ? "hosted" : undefined}
            className="text-[11px] text-muted-foreground"
          >
            unknown
          </span>
        ) : (
          <Switch
            checked={checked}
            disabled={blocked || busy}
            aria-label={ariaLabel}
            data-testid={testId}
            data-policy={String(checked)}
            data-blocked={blocked ? "hosted" : undefined}
            onCheckedChange={onChange}
          />
        )
      }
    />
  );
}

function ResetFallbackButton({
  busy,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly onConfirm: (
    action: NodeE2eeActionId,
    operation: () => Promise<unknown>,
    message: string,
  ) => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      onClick={() => onConfirm("reset-fallback", resetNodeE2eeFallback, "Fallback counters reset.")}
    >
      Reset
    </Button>
  );
}

function ClientRecordRow({
  record,
  busy,
  onAuthorize,
  onApprove,
  onShowApprovalQr,
}: {
  readonly record: NodeE2eeClientRecord;
  readonly busy: boolean;
  readonly onAuthorize: (
    request: NodeE2eeAuthorizationRequest,
    action: NodeE2eeRecordActionId,
    message: string,
  ) => void;
  readonly onApprove: (request: NodeE2eeAuthorizationRequest, role: NodeE2eeApprovableRole) => void;
  readonly onShowApprovalQr: (record: NodeE2eeClientRecord) => void;
}) {
  const key = {
    hubOrigin: record.hubOrigin,
    accountId: record.accountId,
    fingerprint: record.fingerprint,
  };
  const tone = nodeClientStatusTone(record.status);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {nodeClientRowTitle(record)}
          <Badge size="sm" variant={tone === "success" ? "success" : tone}>
            {record.status}
          </Badge>
        </span>
      }
      description={`${record.accountId} at ${record.hubOrigin}`}
      control={
        <>
          {/* §13.6: an approval names the maximum role, and the OWNER names it.
              One button per role rather than one button and a default, because a
              default is the panel choosing the ceiling every channel this key
              opens is admitted under. Least authority first.

              The capability set is NOT the owner's to pick here and is not left
              empty: §8.6 step 6 admits a native handshake only if the record's
              set contains the intended capability, and `RelayCapability` has one
              member — so an empty set approves a key that is refused by every
              handshake it attempts. */}
          {record.status === "approved"
            ? null
            : NODE_E2EE_APPROVABLE_ROLES.map((role) => (
                <Button
                  key={role}
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    onApprove(
                      {
                        ...key,
                        action: "approve",
                        maxRole: role,
                        capabilitySet: NODE_E2EE_APPROVAL_CAPABILITY_SET,
                      },
                      role,
                    )
                  }
                >
                  Approve as {role}
                </Button>
              ))}
          {/* Absent at `viewer`: the node treats a narrow that changes nothing as
              a no-op, so the button would offer an action with no effect behind a
              dialog promising immediate channel closure. */}
          {record.status === "approved" && record.maxRole !== "viewer" ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() =>
                onAuthorize(
                  { ...key, action: "narrow", maxRole: "viewer" },
                  "narrow",
                  "Authority reduced.",
                )
              }
            >
              Reduce to viewer
            </Button>
          ) : null}
          {record.status === "approved" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onShowApprovalQr(record)}
            >
              <QrCodeIcon className="size-3.5" />
              Show phone QR
            </Button>
          ) : null}
          {record.status === "revoked" ? null : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => onAuthorize({ ...key, action: "revoke" }, "revoke", "Client revoked.")}
            >
              Revoke
            </Button>
          )}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => onAuthorize({ ...key, action: "purge" }, "purge", "Record deleted.")}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-3.5">
        <FactRows rows={nodeClientRows(record)} />
        <SafetyNumber value={record.safetyNumber} />
      </div>
    </SettingsRow>
  );
}
