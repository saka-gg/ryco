// Hosted account settings: passkeys, two-factor, password, email, and recovery
// codes, driven entirely by `hostedHubController` and the two runtime stores.
//
// Three rules shape this file, and none of them is cosmetic:
//
//   1. **Step-up is discovered, never assumed.** Nothing here can tell whether
//      the current session was minted from a passkey or from a fallback
//      credential — neither the client session nor the Hub says. So an action is
//      attempted, and a TOTP field appears only after the Hub has refused it
//      with the step-up gate. A field rendered up front would be a guess, and a
//      wrong one for every passkey session.
//   2. **Secret material is transient, but it is the user who ends it.** Recovery
//      codes and the TOTP enrolment secret live in one in-memory runtime slot
//      each. This surface renders them, never copies them into its own state,
//      never puts them in a URL or a log, and drops them when the user says so.
//      It does **not** drop them on teardown: this panel is unmounted by a node
//      switch, a dialog close, and a tier flip, none of which is the user
//      deciding they have saved a secret that by then is the only one that
//      works.
//   3. **A fallback is never dressed up as a passkey.** Password, recovery code,
//      and emailed link are the weaker ways in, and the copy says so.

import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type {
  HostedAccountOutcome,
  HostedAccountSecurity,
  HostedAccountStepUp,
  HostedExternalIdentity,
  HostedHubPasskey,
} from "@ryco/client-runtime/authorization";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  hostedHubController,
  useHostedAccountStore,
  useHostedHubStore,
} from "../../hostedHub/state";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { QRCodeSvg } from "../ui/qr-code";
import { GitHubIcon } from "../Icons";
import { Spinner } from "../ui/spinner";
import {
  accountPosture,
  activePasskeys,
  emailIssue,
  EMAIL_MAX_LENGTH,
  inlineErrorMessage,
  isPasskeyRevoked,
  isPasskeySessionRequired,
  isStepUpRefusal,
  formatRecoveryCodesForClipboard,
  normalizePasskeyLabel,
  normalizeTotpCode,
  orderPasskeys,
  passkeyBackupSummary,
  passkeyDisplayLabel,
  passwordIssue,
  PASSWORD_MAX_LENGTH,
  isSubmittableTotpCode,
  shouldRetryStepUp,
  stepUpDescription,
  syncedPasskeyCount,
  stepUpTitle,
  STEP_UP_UNRESOLVED_MESSAGE,
  TOTP_CODE_MAX_LENGTH,
  type AccountStepUpAction,
} from "./AccountSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  beginGitHubAuthorization,
  externalIdentityPendingErrorMessage,
  githubProviderPolicy,
} from "../hostedHub/ExternalIdentityWeb.logic";
import { AccountE2eeDevices } from "./AccountE2eeDevices";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatEpoch(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return timestampFormatter.format(new Date(value));
}

/**
 * What a caller wants done with the outcome of one account action.
 *
 * `onCommitted` fires on exactly one of the paths that can succeed — the first
 * attempt, or the retry that carried a code — so a caller's cleanup cannot be
 * skipped just because the session turned out to need a step-up.
 */
interface AccountActionOptions {
  /** Cleanup for the one path where the action committed. */
  readonly onCommitted?: () => void;
  /**
   * Cleanup for an attempt the user walked away from, or that this surface gave
   * up on: a cancelled step-up, a dismissed form, a request aborted because it
   * was never going to answer, a step-up prompt abandoned because it could not
   * succeed. A caller holding secret material must drop it here — an attempt
   * that ended is not a reason to keep the user's typed password in a React
   * state.
   */
  readonly onAbandoned?: () => void;
}

/** An account action as this surface calls it: step-up in, outcome out. */
type AccountActionThunk = (input: HostedAccountStepUp) => Promise<HostedAccountOutcome>;

/**
 * A step-up the Hub asked for: the action's identity (for the prompt copy), the
 * caller's own thunk re-run verbatim with the code the user supplies, and the
 * caller's cleanups.
 *
 * Re-running the caller's thunk rather than reconstructing the request keeps the
 * retry identical to the attempt. It does **not** keep the user's secret out of
 * this state, and nothing here should claim otherwise: the thunk is a closure
 * over whatever the caller captured, the typed password included. So the
 * closure is released the moment the step-up ends, and `onAbandoned` gives the
 * caller the same chance to release its own copy.
 */
interface PendingStepUp {
  readonly action: AccountStepUpAction;
  readonly run: AccountActionThunk;
  readonly options: AccountActionOptions | undefined;
  /**
   * Whether the step-up code was the Hub's answer or this client's guess.
   *
   * `step_up_required` is synthesised from a bare `forbidden`, so the prompt
   * must not assert what the Hub did not say. Carried on the refusal that
   * opened the prompt rather than re-read from the store, which a concurrent
   * action can overwrite.
   */
  readonly inferred: boolean;
}

/**
 * Run an account action, and escalate to a step-up prompt if the refusal says
 * the session needs one.
 *
 * The runtime resolves a discriminated outcome, so what happened is read off the
 * value this surface is already holding. It is deliberately not re-read from
 * `hostedAccountStore` after the await: that read is racy (a concurrent action
 * or the post-commit confirming refresh writes the same slot) and ambiguous (a
 * cancelled action leaves no error behind, so "no error" is not success).
 */
function useAccountAction() {
  const [stepUp, setStepUp] = useState<PendingStepUp | null>(null);
  const [stepUpRefusals, setStepUpRefusals] = useState(0);
  const [stepUpCode, setStepUpCode] = useState("");
  /**
   * Set when a step-up prompt was abandoned because it could not succeed — an
   * inferred `step_up_required` refused to its limit. The refusal message on the
   * store still says "enter a code", which by then is the one thing known not to
   * be the whole story, so the surface says something honest instead.
   */
  const [stepUpUnresolved, setStepUpUnresolved] = useState(false);
  /**
   * Which attempt this surface is waiting on.
   *
   * The outcome now tells this hook whether an attempt committed, so a stale
   * continuation can no longer be mistaken for a success. What it can still do
   * is re-open a prompt, or clear a form, for an attempt the user already walked
   * away from. Bumping this on every start and every abandonment makes such a
   * continuation identifiable, and inert.
   */
  const attemptRef = useRef(0);

  const clearStepUp = useCallback(() => {
    setStepUp(null);
    setStepUpRefusals(0);
    setStepUpCode("");
  }, []);

  /**
   * Abandon whatever is in flight.
   *
   * A platform passkey sheet the user walks away from never returns and never
   * rejects, and a request can hang for as long as the network lets it. Without
   * an abort the surface stays busy for the life of the session behind a modal
   * whose every exit is disabled — only a reload gets out. This aborts the
   * runtime's operation, drops the pending step-up along with the closure it
   * holds over the caller's secret, and tells the caller to drop its own.
   */
  const cancel = useCallback(() => {
    attemptRef.current += 1;
    hostedHubController.cancelAccountAction();
    stepUp?.options?.onAbandoned?.();
    setStepUpUnresolved(false);
    clearStepUp();
  }, [clearStepUp, stepUp]);

  const run = useCallback(
    async (
      action: AccountStepUpAction,
      thunk: AccountActionThunk,
      options?: AccountActionOptions,
    ): Promise<void> => {
      const attempt = (attemptRef.current += 1);
      setStepUpUnresolved(false);
      const outcome = await thunk({});
      if (attemptRef.current !== attempt) return;
      if (isStepUpRefusal(outcome)) {
        setStepUpCode("");
        setStepUpRefusals(0);
        setStepUp({
          action,
          run: thunk,
          options,
          inferred: outcome.inferredErrorCode === true,
        });
        return;
      }
      if (outcome.status === "committed") options?.onCommitted?.();
    },
    [],
  );

  const submitStepUp = useCallback(async () => {
    if (!stepUp) return;
    const totpCode = normalizeTotpCode(stepUpCode);
    if (totpCode.length === 0) return;
    const attempt = (attemptRef.current += 1);
    const outcome = await stepUp.run({ totpCode });
    if (attemptRef.current !== attempt) return;
    if (isStepUpRefusal(outcome)) {
      const refusals = stepUpRefusals + 1;
      if (shouldRetryStepUp(outcome, refusals)) {
        setStepUpRefusals(refusals);
        setStepUpCode("");
        return;
      }
      // The code was synthesised from a bare `forbidden` and has been refused to
      // the limit, so this prompt is as likely to be answering the wrong
      // question as the right one. Stop asking, release the caller's secret, and
      // let the surface say what is actually known.
      setStepUpUnresolved(true);
      stepUp.options?.onAbandoned?.();
      clearStepUp();
      return;
    }
    if (outcome.status === "committed") stepUp.options?.onCommitted?.();
    clearStepUp();
  }, [clearStepUp, stepUp, stepUpCode, stepUpRefusals]);

  return {
    run,
    cancel,
    stepUp,
    stepUpAttempts: stepUpRefusals,
    stepUpCode,
    stepUpUnresolved,
    setStepUpCode,
    submitStepUp,
  };
}

/**
 * Declare that this surface is displaying the one-time recovery codes, for as
 * long as it is mounted. That is the whole of this surface's involvement in the
 * lifetime of the two secrets it renders.
 *
 * The lease is load-bearing rather than defensive: the runtime publishes rotated
 * codes only if a lease was live when the rotation was asked for, so without
 * this line every rotation from here would rotate the user's codes server-side
 * and then come back `displayed: false` with nothing to show. It also keeps
 * `HostedHubRoot`'s full-screen takeover out of the way while this surface is
 * the one showing them.
 *
 * **The release destroys nothing, and nothing else here does either.** This
 * cleanup used to end in `dismissRecoveryCodes()` and `dismissTotpEnrollment()`,
 * which made every involuntary teardown destroy a secret the Hub had already
 * made authoritative — and this panel is torn down for reasons that are not the
 * user's: `clearWebHostedNodeScopedState` calls `closeSettings()` on every
 * hosted node deactivate, suspend, and switch, and `SettingsSurfaceMount`
 * remounts it at a new position whenever the presentation tier flips. Both left
 * the account holding recovery codes nobody had ever seen. The codes and the
 * enrolment secret now go away on an explicit acknowledgement (the buttons
 * below) or with the account, and on nothing else.
 */
function useRecoveryCodeDisplayLease(): void {
  useEffect(() => hostedHubController.leaseRecoveryCodeDisplay(), []);
}

/** A busy control: the label with a spinner while this action is the live one. */
function ActionLabel({ busy, children }: { readonly busy: boolean; readonly children: ReactNode }) {
  return busy ? (
    <>
      <Spinner className="size-3.5" />
      {children}
    </>
  ) : (
    <>{children}</>
  );
}

export function AccountSettingsPanel() {
  const accountStatus = useHostedHubStore((state) => state.accountStatus);
  const account = useHostedHubStore((state) => state.account);
  // Lifted out of `PasskeysSection` so the posture alert's "Add passkey" opens
  // the same dialog the section owns — one dialog, one piece of state.
  const [addPasskeyOpen, setAddPasskeyOpen] = useState(false);
  const passkeys = useHostedAccountStore((state) => state.passkeys);
  const passkeysStatus = useHostedAccountStore((state) => state.passkeysStatus);
  const security = useHostedAccountStore((state) => state.security);
  const securityStatus = useHostedAccountStore((state) => state.securityStatus);
  const externalIdentityConfiguration = useHostedAccountStore(
    (state) => state.externalIdentityConfiguration,
  );
  const actionStatus = useHostedAccountStore((state) => state.actionStatus);
  const errorMessage = useHostedAccountStore((state) => state.errorMessage);
  const errorCode = useHostedAccountStore((state) => state.errorCode ?? null);
  const recoveryCodes = useHostedHubStore((state) => state.recoveryCodes);
  const totpEnrollment = useHostedHubStore((state) => state.totpEnrollment ?? null);
  const [externalIdentityPending, setExternalIdentityPending] = useState(false);
  const [externalIdentityError, setExternalIdentityError] = useState<string | null>(null);
  const pendingExternalIdentityChecked = useRef(false);

  const action = useAccountAction();
  const runAccountAction = action.run;
  useRecoveryCodeDisplayLease();
  const busy = actionStatus !== "idle";
  const githubPolicy = githubProviderPolicy(externalIdentityConfiguration);
  const githubIdentity =
    security?.externalIdentities.find((identity) => identity.provider === "github") ?? null;

  const startGitHubConnection = async () => {
    if (externalIdentityPending) return;
    setExternalIdentityPending(true);
    setExternalIdentityError(null);
    try {
      await beginGitHubAuthorization({
        intent: "link",
        returnTo: "/account/security",
        start: (request) => hostedHubApi.startExternalIdentityAuthorization(request),
        navigate: (authorizationUrl) => window.location.assign(authorizationUrl),
      });
    } catch (cause) {
      setExternalIdentityError(
        cause instanceof HostedHubApiError
          ? cause.message
          : "GitHub connection is temporarily unavailable.",
      );
      setExternalIdentityPending(false);
    }
  };

  useEffect(() => {
    void hostedHubController.refreshPasskeys();
    void hostedHubController.refreshAccountSecurity();
    void hostedHubController.refreshExternalIdentityConfiguration();
  }, []);

  useEffect(() => {
    if (accountStatus !== "authenticated" || pendingExternalIdentityChecked.current) return;
    pendingExternalIdentityChecked.current = true;
    const operation = new AbortController();
    void hostedHubApi
      .getPendingExternalIdentity(operation.signal)
      .then((pending) => {
        if (pending.status === "link") {
          return runAccountAction("connect-github", (stepUp) =>
            hostedHubController.finishBrowserExternalIdentityConnection("github", stepUp),
          );
        }
        if (pending.status === "error") {
          setExternalIdentityError(externalIdentityPendingErrorMessage(pending.code));
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => operation.abort();
  }, [accountStatus, runAccountAction]);

  if (accountStatus !== "authenticated") {
    return (
      <SettingsPageContainer>
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Not signed in</AlertTitle>
          <AlertDescription>
            Sign in to the Hub to manage passkeys, two-factor authentication, and recovery codes.
          </AlertDescription>
        </Alert>
      </SettingsPageContainer>
    );
  }

  // An abandoned step-up outranks the store's own message: the store still says
  // "enter a code", and by then that is the claim this surface has stopped
  // believing.
  const inlineError = action.stepUpUnresolved
    ? STEP_UP_UNRESOLVED_MESSAGE
    : inlineErrorMessage(errorMessage, errorCode, action.stepUp !== null);
  const passkeySessionGate = !action.stepUpUnresolved && isPasskeySessionRequired(errorCode);
  const posture = accountPosture(passkeys, passkeysStatus);

  // The page descends by strength: passkey, second factor, last-resort
  // recovery, then the weak ways in. Recovery codes sit *above* the fallbacks
  // because they are the thing a user has to act on early, before losing a
  // device — under two write-only forms, one of which cannot deliver anything,
  // they were the least likely row on the page to be read.
  return (
    <SettingsPageContainer>
      {inlineError ? (
        <Alert variant={passkeySessionGate ? "info" : "error"} aria-live="polite">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>{passkeySessionGate ? "Passkey needed" : "That did not work"}</AlertTitle>
          <AlertDescription>{inlineError}</AlertDescription>
        </Alert>
      ) : null}

      {externalIdentityError ? (
        <Alert variant="warning" aria-live="polite">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>GitHub connection did not complete</AlertTitle>
          <AlertDescription>{externalIdentityError}</AlertDescription>
        </Alert>
      ) : null}

      {security === null && securityStatus !== "stale" ? (
        <Alert variant="info" aria-live="polite">
          <ShieldCheckIcon aria-hidden />
          <AlertTitle>Checking account security</AlertTitle>
          <AlertDescription>
            Reading which fallback sign-in methods are configured on this Hub.
          </AlertDescription>
        </Alert>
      ) : null}

      {securityStatus === "stale" ? (
        <Alert variant="warning" aria-live="polite">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>
            {security === null
              ? "Account security unavailable"
              : "Account security may be outdated"}
          </AlertTitle>
          <AlertDescription>
            {security === null
              ? "Ryco could not read the current password, authenticator, and email state."
              : "These controls use the last state Ryco successfully read from the Hub."}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void hostedHubController.refreshAccountSecurity({ force: true })}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {posture ? (
        <Alert variant={posture.variant} aria-live="polite">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>{posture.title}</AlertTitle>
          <AlertDescription>{posture.description}</AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setAddPasskeyOpen(true)}
            >
              {posture.actionLabel}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <SettingsSection title="Account" icon={<UserRoundIcon aria-hidden className="size-3.5" />}>
        <SettingsRow
          title={account?.displayName ?? "Signed in"}
          description="The Hub account these credentials belong to."
          status={
            account
              ? `${account.role} · joined ${formatEpoch(account.createdAt) ?? "unknown"}`
              : null
          }
        />
      </SettingsSection>

      <AccountE2eeDevices />

      {githubIdentity || githubPolicy?.link ? (
        <ExternalIdentitySection
          identity={githubIdentity}
          actionsAvailable={githubPolicy?.link === true}
          busy={busy || externalIdentityPending}
          actionStatus={actionStatus}
          onConnect={() => void startGitHubConnection()}
          run={runAccountAction}
        />
      ) : null}

      <PasskeysSection
        passkeys={passkeys}
        loading={passkeysStatus === "loading"}
        stale={passkeysStatus === "stale"}
        busy={busy}
        actionStatus={actionStatus}
        addOpen={addPasskeyOpen}
        setAddOpen={setAddPasskeyOpen}
        run={action.run}
        cancel={action.cancel}
      />

      <TwoFactorSection
        busy={busy}
        actionStatus={actionStatus}
        enrollment={totpEnrollment}
        enrolled={security?.totpEnrolled ?? null}
        run={action.run}
      />

      <RecoveryCodesSection
        busy={busy}
        actionStatus={actionStatus}
        recoveryCodes={recoveryCodes}
        run={action.run}
      />

      {/* Password and email are both fallbacks and both write-only. Grouping
          them says "these are the weak ways in" structurally, which makes the
          never-equal-to-a-passkey rule a property of the layout rather than a
          claim in copy. */}
      <FallbackSignInSection
        busy={busy}
        actionStatus={actionStatus}
        security={security}
        run={action.run}
        cancel={action.cancel}
      />

      <StepUpDialog
        pending={action.stepUp}
        attempts={action.stepUpAttempts}
        code={action.stepUpCode}
        onCodeChange={action.setStepUpCode}
        onSubmit={action.submitStepUp}
        onCancel={action.cancel}
        busy={busy}
      />
    </SettingsPageContainer>
  );
}

type RunAccountAction = (
  action: AccountStepUpAction,
  thunk: AccountActionThunk,
  options?: AccountActionOptions,
) => Promise<void>;

/** Abandon the action in flight, aborting it in the runtime. */
type CancelAccountAction = () => void;

function ExternalIdentitySection({
  identity,
  actionsAvailable,
  busy,
  actionStatus,
  onConnect,
  run,
}: {
  readonly identity: HostedExternalIdentity | null;
  readonly actionsAvailable: boolean;
  readonly busy: boolean;
  readonly actionStatus: string;
  readonly onConnect: () => void;
  readonly run: RunAccountAction;
}) {
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const connecting = actionStatus === "connecting-external-identity";
  const disconnecting = actionStatus === "disconnecting-external-identity";

  const disconnect = async () => {
    await run(
      "disconnect-github",
      (stepUp) => hostedHubController.disconnectExternalIdentity("github", stepUp),
      { onCommitted: () => setDisconnectOpen(false) },
    );
  };

  return (
    <SettingsSection
      title="Connected accounts"
      icon={<GitHubIcon aria-hidden className="size-3.5" />}
    >
      <SettingsRow
        title={identity ? `GitHub · @${identity.login}` : "GitHub"}
        description={
          identity
            ? "Use this GitHub identity to sign in to Ryco. Repository access remains separate."
            : "Connect GitHub as another way to sign in. Ryco requests no repository access."
        }
        status={
          identity
            ? `Connected ${formatEpoch(identity.connectedAt) ?? "at an unknown time"}${
                identity.lastUsedAt === null
                  ? ""
                  : ` · last used ${formatEpoch(identity.lastUsedAt) ?? "at an unknown time"}`
              }`
            : null
        }
        control={
          !actionsAvailable ? null : identity ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDisconnectOpen(true)}
            >
              <ActionLabel busy={disconnecting}>Disconnect</ActionLabel>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={onConnect}>
              <ActionLabel busy={connecting}>Connect GitHub</ActionLabel>
            </Button>
          )
        }
      />
      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
            <AlertDialogDescription>
              You will no longer be able to sign in with GitHub. Ryco refuses this change if GitHub
              is your only remaining sign-in method.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button disabled={busy} onClick={() => void disconnect()}>
              <ActionLabel busy={disconnecting}>Disconnect GitHub</ActionLabel>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ passkeys */

function PasskeysSection({
  passkeys,
  loading,
  stale,
  busy,
  actionStatus,
  addOpen,
  setAddOpen,
  run,
  cancel,
}: {
  readonly passkeys: ReadonlyArray<HostedHubPasskey>;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly actionStatus: string;
  readonly addOpen: boolean;
  readonly setAddOpen: (open: boolean) => void;
  readonly run: RunAccountAction;
  readonly cancel: CancelAccountAction;
}) {
  const [label, setLabel] = useState("");
  const [pendingRevoke, setPendingRevoke] = useState<HostedHubPasskey | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const adding = actionStatus === "adding-passkey";
  const revoking = actionStatus === "revoking-passkey";
  const active = activePasskeys(passkeys);
  const synced = syncedPasskeyCount(passkeys);
  const ordered = orderPasskeys(passkeys);

  const closeAdd = useCallback(() => {
    setLabel("");
    setAddOpen(false);
  }, [setAddOpen]);

  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    const passkeyLabel = normalizePasskeyLabel(label);
    // Whether the credential was enrolled is data, not an inference. The runtime
    // reaches its confirming re-read only after the Hub has accepted the
    // ceremony, so a `committed` outcome means a credential exists whatever the
    // read then managed to see — `confirmation` says how well that could be
    // checked, and the runtime publishes its own message for the cases it could
    // not. Closing on it is what stops a second "Create passkey" press turning
    // an unverifiable enrolment into a duplicate credential; keeping it open on
    // a refusal is what lets a ceremony that really did fail be retried.
    await run(
      "add-passkey",
      (stepUp) => hostedHubController.addPasskey({ passkeyLabel, ...stepUp }),
      { onCommitted: closeAdd, onAbandoned: closeAdd },
    );
  };

  const confirmRevoke = async () => {
    const target = pendingRevoke;
    if (!target) return;
    setPendingRevoke(null);
    // Held past the confirmation so the row's spinner has something to key on:
    // revoking is destructive and slow enough to be worth reporting, and
    // clearing the pending target alone left `busy` false for its whole
    // duration and the spinner permanently unreachable.
    setRevokingId(target.id);
    try {
      await hostedHubController.revokePasskey(target.id);
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SettingsSection
      title="Passkeys"
      icon={<KeyRoundIcon aria-hidden className="size-3.5" />}
      headerAction={
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setAddOpen(true)}>
          Add passkey
        </Button>
      }
    >
      <SettingsRow
        title="Passkeys on this account"
        description="A passkey is the strongest way in. Add one for every device you sign in from, and keep at least two so losing a device does not lock you out."
        status={
          stale ? (
            "This list could not be refreshed and may be out of date."
          ) : (
            <>
              {/* Its own element so the count stays independently addressable
                  and readable, whether or not the sync clause follows it. */}
              <span>{`${String(active.length)} usable ${active.length === 1 ? "passkey" : "passkeys"}`}</span>
              {/* Only a positive count is reported. `backupState` is nullable
                  and `null` means the Hub did not say, so "0 synced" would be
                  a claim about credentials nobody made. */}
              {synced > 0 ? (
                <span>{` · ${String(synced)} synced to a password manager`}</span>
              ) : null}
            </>
          )
        }
      />
      {loading && passkeys.length === 0 ? (
        <SettingsRow title="Loading passkeys…" description="Reading the credentials on file." />
      ) : null}
      {!loading && passkeys.length === 0 ? (
        <SettingsRow
          title="No passkeys yet"
          description="Add one now — without a passkey you can only get back in through a fallback credential."
        />
      ) : null}
      {ordered.map((passkey) => {
        const revoked = isPasskeyRevoked(passkey);
        const backup = passkeyBackupSummary(passkey);
        const created = formatEpoch(passkey.createdAt);
        const lastUsed = formatEpoch(passkey.lastUsedAt);
        return (
          <SettingsRow
            key={passkey.id}
            title={
              <span className="flex items-center gap-2">
                {passkeyDisplayLabel(passkey)}
                {revoked ? (
                  <Badge variant="error" size="sm">
                    Revoked
                  </Badge>
                ) : null}
              </span>
            }
            description={
              revoked
                ? `Revoked${passkey.revocationReasonCode ? ` — ${passkey.revocationReasonCode}` : ""}. This credential can no longer sign in.`
                : (backup ?? "The Hub did not report whether this credential is backed up.")
            }
            status={[
              created ? `Added ${created}` : null,
              lastUsed ? `Last used ${lastUsed}` : "Never used",
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
            control={
              revoked ? null : (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  aria-label={`Revoke ${passkeyDisplayLabel(passkey)}`}
                  disabled={busy}
                  onClick={() => setPendingRevoke(passkey)}
                >
                  <ActionLabel busy={revoking && revokingId === passkey.id}>
                    <Trash2Icon aria-hidden />
                    Revoke
                  </ActionLabel>
                </Button>
              )
            }
          />
        );
      })}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (open) {
            setAddOpen(true);
            return;
          }
          // A ceremony in flight is abandoned only through the explicit Cancel:
          // a stray Escape must not silently abort a platform passkey sheet the
          // user is still working through.
          if (busy) return;
          closeAdd();
        }}
      >
        <DialogPopup className="max-w-md">
          <form onSubmit={(event) => void submitAdd(event)}>
            <DialogHeader>
              <DialogTitle>Add a passkey</DialogTitle>
              <DialogDescription>
                Your browser will ask you to create a passkey for this account. Adding one replaces
                the current Hub session with a fresh one.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <Label htmlFor="account-passkey-label">Name (optional)</Label>
              <Input
                id="account-passkey-label"
                value={label}
                autoComplete="off"
                placeholder="Work laptop"
                disabled={adding}
                className={TOUCH_INPUT_CLASS_NAME}
                onChange={(event) => setLabel(event.target.value)}
              />
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  // Routed through the action hook rather than straight to the
                  // controller: an aborted operation leaves the store idle with
                  // no error, which is indistinguishable from a commit, and the
                  // hook is what fences the abandoned attempt out.
                  cancel();
                  closeAdd();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                <ActionLabel busy={adding}>Create passkey</ActionLabel>
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) setPendingRevoke(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* Stated, never enforced: the Hub is the authority here and
                  answers `conflict` on the last credential. A client-side
                  disable would be a guess whenever the list is stale, and a
                  client must not enforce a server rule it only inferred. */}
              {active.length === 1 ? "This is the only usable passkey on this account. " : ""}
              {pendingRevoke ? passkeyDisplayLabel(pendingRevoke) : ""} will stop working
              immediately, on every device it is stored on. This cannot be undone — you would have
              to enrol the device again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmRevoke()}>
              Revoke passkey
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/* ---------------------------------------------------------------- two-factor */

function TwoFactorSection({
  busy,
  actionStatus,
  enrollment,
  enrolled,
  run,
}: {
  readonly busy: boolean;
  readonly actionStatus: string;
  readonly enrollment: { readonly secretBase32: string; readonly provisioningUri: string } | null;
  readonly enrolled: boolean | null;
  readonly run: RunAccountAction;
}) {
  const [code, setCode] = useState("");
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);
  const enrolling = actionStatus === "enrolling-totp";
  const confirming = actionStatus === "confirming-totp";
  const revoking = actionStatus === "revoking-totp";

  const dismissEnrollment = useCallback(() => {
    setCode("");
    hostedHubController.dismissTotpEnrollment();
  }, []);

  const submitConfirm = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeTotpCode(code);
    if (normalized.length === 0) return;
    await hostedHubController.confirmTotpEnrollment({ code: normalized });
    // The runtime drops the secret on a confirmed enrolment; clear the typed
    // code either way so a rejected attempt does not leave it in a field.
    setCode("");
  };

  const confirmRevoke = async () => {
    setConfirmRevokeOpen(false);
    await run("revoke-totp", (stepUp) => hostedHubController.revokeTotp(stepUp));
  };

  return (
    <SettingsSection
      title="Two-factor authentication"
      icon={<ShieldCheckIcon aria-hidden className="size-3.5" />}
    >
      <SettingsRow
        title="Authenticator app"
        description="A six-digit code from an authenticator app, required whenever you change credentials from a session that was not started with a passkey. Signing in with a passkey never asks for one."
        status={enrolled === null ? "Checking current state…" : enrolled ? "On" : "Off"}
        control={
          enrolled === null ? null : enrolled ? (
            <Button
              size="xs"
              variant="destructive-outline"
              aria-label="Turn off two-factor authentication"
              disabled={busy}
              onClick={() => setConfirmRevokeOpen(true)}
            >
              <ActionLabel busy={revoking}>Turn off</ActionLabel>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void hostedHubController.beginTotpEnrollment()}
            >
              <ActionLabel busy={enrolling}>Set up</ActionLabel>
            </Button>
          )
        }
      />

      <Dialog
        open={enrollment !== null}
        onOpenChange={(open) => {
          if (!open) dismissEnrollment();
        }}
      >
        <DialogPopup className="max-w-md">
          <form onSubmit={(event) => void submitConfirm(event)}>
            <DialogHeader>
              <DialogTitle>Set up two-factor authentication</DialogTitle>
              <DialogDescription>
                Scan this with your authenticator app, then enter the code it shows. This is the
                only time the key is displayed.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              {enrollment ? (
                <>
                  <div className="flex justify-center rounded-xl border border-border bg-white p-4">
                    <QRCodeSvg
                      value={enrollment.provisioningUri}
                      size={168}
                      level="M"
                      marginSize={1}
                      title="Two-factor setup code"
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Can&apos;t scan? Enter this key manually:
                    </p>
                    <p
                      aria-label="Two-factor setup key"
                      className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm break-all"
                    >
                      {enrollment.secretBase32}
                    </p>
                  </div>
                </>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="account-totp-confirm">Code from your app</Label>
                <Input
                  id="account-totp-confirm"
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={TOTP_CODE_MAX_LENGTH}
                  disabled={confirming}
                  className={TOUCH_INPUT_CLASS_NAME}
                  onChange={(event) => setCode(normalizeTotpCode(event.target.value))}
                />
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={dismissEnrollment}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !isSubmittableTotpCode(code)}>
                <ActionLabel busy={confirming}>Turn on</ActionLabel>
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={confirmRevokeOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setConfirmRevokeOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove two-factor authentication?</AlertDialogTitle>
            <AlertDialogDescription>
              Password, recovery-code, and emailed-link sign-ins will no longer need a code from
              your authenticator app. You can set it up again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it on</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmRevoke()}>
              Remove two-factor
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/* --------------------------------------------------------- fallback sign-in */

/**
 * Password and email in one section.
 *
 * Both are fallbacks, and the Hub's authenticated security read determines
 * which password action and email status are valid. One section headed
 * "Fallback sign-in" places them structurally below the passkey and the second
 * factor, which is a stronger statement of the never-equal rule than any
 * sentence could be.
 */
function FallbackSignInSection({
  busy,
  actionStatus,
  security,
  run,
  cancel,
}: {
  readonly busy: boolean;
  readonly actionStatus: string;
  readonly security: HostedAccountSecurity | null;
  readonly run: RunAccountAction;
  readonly cancel: CancelAccountAction;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const setting = actionStatus === "setting-password";
  const removing = actionStatus === "removing-password";
  const issue = passwordIssue(password, confirmation);

  const clear = useCallback(() => {
    setPassword("");
    setConfirmation("");
    setTouched(false);
  }, []);

  /**
   * Close and forget. The typed password is plaintext in this component's state
   * and, once a step-up is pending, in the closure the step-up re-runs; both
   * have to go the moment the attempt ends, however it ends.
   */
  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  /** Abandon an attempt: abort anything in flight, then close and forget. */
  const abandon = useCallback(() => {
    cancel();
    close();
  }, [cancel, close]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue) return;
    await run(
      "set-password",
      (stepUp) => hostedHubController.setPassword({ password, ...stepUp }),
      {
        onCommitted: close,
        onAbandoned: close,
      },
    );
  };

  const confirmRemove = async () => {
    setConfirmRemoveOpen(false);
    await run("remove-password", (stepUp) => hostedHubController.removePassword(stepUp));
  };

  return (
    <SettingsSection
      title="Fallback sign-in"
      icon={<KeyRoundIcon aria-hidden className="size-3.5" />}
    >
      <SettingsRow
        title="Fallback password"
        description="A password is a fallback, not an equal of a passkey: it can be phished and reused, and a session started with one has to prove itself again before changing credentials. Keep a passkey as your normal way in."
        status={
          security === null
            ? "Checking current state…"
            : security.passwordConfigured
              ? "Set"
              : "Not set"
        }
        control={
          security === null ? null : (
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
                <ActionLabel busy={setting}>
                  {security.passwordConfigured ? "Change" : "Set password"}
                </ActionLabel>
              </Button>
              {security.passwordConfigured ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  aria-label="Delete the fallback password"
                  disabled={busy}
                  onClick={() => setConfirmRemoveOpen(true)}
                >
                  <ActionLabel busy={removing}>Remove</ActionLabel>
                </Button>
              ) : null}
            </div>
          )
        }
      />
      <EmailRows
        busy={busy}
        actionStatus={actionStatus}
        email={security === null ? undefined : security.email}
        deliveryConfigured={security?.emailDeliveryConfigured}
        run={run}
      />

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
            return;
          }
          // Every dismissal is an abandonment, including one made while a
          // request is in flight: without the abort a set-password that never
          // answers leaves this dialog with no working exit at all. The typed
          // password is never carried across.
          abandon();
        }}
      >
        <DialogPopup className="max-w-md">
          <form onSubmit={(event) => void submit(event)}>
            <DialogHeader>
              <DialogTitle>Set a fallback password</DialogTitle>
              <DialogDescription>
                This replaces any password already on the account. The Hub rejects passwords that
                have appeared in a known breach.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="account-password">New password</Label>
                <Input
                  id="account-password"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  maxLength={PASSWORD_MAX_LENGTH}
                  disabled={setting}
                  className={TOUCH_INPUT_CLASS_NAME}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-password-confirm">Confirm password</Label>
                <Input
                  id="account-password-confirm"
                  type="password"
                  value={confirmation}
                  autoComplete="new-password"
                  maxLength={PASSWORD_MAX_LENGTH}
                  disabled={setting}
                  className={TOUCH_INPUT_CLASS_NAME}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
              {touched && issue ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {issue}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={abandon}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                <ActionLabel busy={setting}>Save password</ActionLabel>
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={confirmRemoveOpen}
        onOpenChange={(next) => {
          if (busy) return;
          setConfirmRemoveOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the password?</AlertDialogTitle>
            <AlertDialogDescription>
              You will no longer be able to sign in with a password. Make sure you still have a
              passkey, or recovery codes you have saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmRemove()}>
              Remove password
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/* --------------------------------------------------------------------- email */

/**
 * The email rows, as rows rather than as a section of their own: an emailed
 * link is a fallback sign-in, and the merged section is what says so. The copy,
 * the delivery warning, and the "answers the same way either way" clause are
 * unchanged — a committed outcome means *accepted*, never delivered.
 */
function EmailRows({
  busy,
  actionStatus,
  email: configuredEmail,
  deliveryConfigured,
  run,
}: {
  readonly busy: boolean;
  readonly actionStatus: string;
  /** `undefined` means the security read has not produced a value yet. */
  readonly email: HostedAccountSecurity["email"] | undefined;
  readonly deliveryConfigured: boolean | undefined;
  readonly run: RunAccountAction;
}) {
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const requesting = actionStatus === "requesting-email-verification";
  const issue = emailIssue(email);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setAccepted(false);
    if (issue) return;
    await run(
      "request-email-verification",
      (stepUp) => hostedHubController.requestEmailVerification({ email: email.trim(), ...stepUp }),
      {
        onCommitted: () => {
          setAccepted(true);
          // The address has been handed to the Hub; leaving it in the field
          // keeps a piece of the user's identity on screen, and one stray
          // second press away from being sent again.
          setEmail("");
          setTouched(false);
        },
      },
    );
  };

  return (
    <>
      {deliveryConfigured === false ? (
        <div className="border-t border-border/60 px-4 pt-3.5 sm:px-5">
          <Alert variant="warning">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>No mail will arrive yet</AlertTitle>
            <AlertDescription>
              This Hub has no mail transport configured, so verification messages are generated and
              discarded. The request below will be accepted and nothing will be delivered until an
              operator wires one up. Do not rely on email as your way back into the account.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <SettingsRow
        title="Recovery email"
        description={
          deliveryConfigured
            ? "Used for account recovery after verification. The Hub answers the same way whether or not the address is already known, so this never confirms who owns it."
            : "Used for account recovery once mail delivery is switched on. The Hub answers the same way whether or not the address is already known, so this never confirms who owns it."
        }
        status={
          configuredEmail === undefined
            ? "Checking current state…"
            : configuredEmail === null
              ? "Not set"
              : `${configuredEmail.verified ? "Verified" : "Verification pending"} · ${configuredEmail.address}`
        }
      >
        {configuredEmail !== undefined ? (
          <form className="pt-3 pb-3.5" onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="Email address"
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@example.com"
                maxLength={EMAIL_MAX_LENGTH}
                disabled={requesting}
                className={TOUCH_INPUT_CLASS_NAME}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setAccepted(false);
                }}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={busy}
                className="shrink-0"
              >
                <ActionLabel busy={requesting}>
                  {configuredEmail === null
                    ? "Send verification"
                    : configuredEmail.verified
                      ? "Change email"
                      : "Resend or change"}
                </ActionLabel>
              </Button>
            </div>
            {touched && issue ? (
              <p role="alert" className="pt-2 text-xs text-destructive-foreground">
                {issue}
              </p>
            ) : null}
            {accepted ? (
              <p role="status" className="pt-2 text-xs text-muted-foreground">
                {deliveryConfigured
                  ? "Verification email requested. Check your inbox and spam folder; delivery may take a moment."
                  : "Request accepted by the Hub. No message will be delivered until a mail transport is configured."}
              </p>
            ) : null}
          </form>
        ) : null}
      </SettingsRow>
    </>
  );
}

/* ------------------------------------------------------------ recovery codes */

function RecoveryCodesSection({
  busy,
  actionStatus,
  recoveryCodes,
  run,
}: {
  readonly busy: boolean;
  readonly actionStatus: string;
  readonly recoveryCodes: ReadonlyArray<string>;
  readonly run: RunAccountAction;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const regenerating = actionStatus === "regenerating-recovery-codes";
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  /**
   * Regeneration is a rotation: it mints a new set and invalidates every code
   * the user has already written down. It runs from this confirmed handler and
   * from nowhere else — never on mount, focus, retry, or reconnect.
   *
   * Nothing wraps the call. The runtime reads this surface's display lease when
   * the rotation is asked for — the user is looking at the panel, so it is
   * live — and publishes the result whether or not the panel is still here when
   * the Hub answers. Anything else drops a set of codes that is by then the only
   * thing still opening the account.
   */
  const confirmRegenerate = async () => {
    setConfirmOpen(false);
    await run("regenerate-recovery-codes", (stepUp) =>
      hostedHubController.regenerateRecoveryCodes(stepUp),
    );
  };

  return (
    <SettingsSection
      title="Recovery codes"
      icon={<RefreshCwIcon aria-hidden className="size-3.5" />}
    >
      <SettingsRow
        title="One-time recovery codes"
        description="Single-use codes that get you back in when you have lost every passkey. They are a last resort, not a substitute for one — anyone holding a code can sign in as you."
        status="Ryco shows them once and never writes them to browser storage."
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            <ActionLabel busy={regenerating}>Generate new codes</ActionLabel>
          </Button>
        }
      />

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setConfirmOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your recovery codes?</AlertDialogTitle>
            <AlertDialogDescription>
              Every code you have already saved stops working immediately. You will get a new set,
              shown once — if you lose them you will have to generate another set from a session you
              can still sign in to.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmRegenerate()}>
              Replace codes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Dialog
        open={recoveryCodes.length > 0}
        disablePointerDismissal
        onOpenChange={(open, eventDetails) => {
          // The acknowledgement below is the only exit, exactly as it is on the
          // hosted root's bootstrap surface. By the time this renders, the
          // rotation has already invalidated every code the user had written
          // down, so an Escape, a backdrop press, or a stray close would destroy
          // the only copy of the set that now protects the account — and the
          // account would be left holding recovery codes its owner does not
          // have. Refusing the close is the whole point; there is no
          // "dismissed" state to fall back to.
          if (!open) eventDetails.cancel();
        }}
      >
        <DialogPopup className="max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>
              {/* The count is read from the set, never assumed: the Hub
                  validates 1..256 codes, so copy or a layout that hard-assumes
                  eight or ten is wrong the day an operator changes it. It sits
                  in the sentence rather than in the heading because "Save your
                  1 recovery codes" is what a heading template produces. */}
              Save all {String(recoveryCodes.length)} codes — they are shown once and cannot be
              retrieved later. Store them somewhere only you can reach — a password manager, or
              paper somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul
              aria-label="Recovery codes"
              className="grid gap-2 rounded-xl border border-border bg-background p-4 font-mono text-sm break-all sm:grid-cols-2"
            >
              {recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                copyToClipboard(formatRecoveryCodesForClipboard(recoveryCodes), undefined)
              }
            >
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {isCopied ? "Copied" : "Copy codes"}
            </Button>
            <Button onClick={() => hostedHubController.dismissRecoveryCodes()}>
              I saved the codes
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------- step-up */

function StepUpDialog({
  pending,
  attempts,
  code,
  onCodeChange,
  onSubmit,
  onCancel,
  busy,
}: {
  readonly pending: PendingStepUp | null;
  readonly attempts: number;
  readonly code: string;
  readonly onCodeChange: (value: string) => void;
  readonly onSubmit: () => Promise<void>;
  readonly onCancel: () => void;
  readonly busy: boolean;
}) {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        // Every exit abandons the attempt, in flight or not. A retry that hangs
        // must not be able to wedge this prompt shut: `onCancel` aborts the
        // runtime operation, so Escape, the backdrop, and the button below all
        // work while the request is still outstanding.
        if (!open) onCancel();
      }}
    >
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{pending ? stepUpTitle(pending.action) : ""}</DialogTitle>
            <DialogDescription>
              {stepUpDescription(attempts, pending?.inferred ?? false)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <Label htmlFor="account-step-up-code">Authenticator code</Label>
            <Input
              id="account-step-up-code"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={TOTP_CODE_MAX_LENGTH}
              disabled={busy}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => onCodeChange(normalizeTotpCode(event.target.value))}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !isSubmittableTotpCode(code)}>
              <ActionLabel busy={busy}>Confirm code</ActionLabel>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
