// The parts of the hosted account that are not credentials: who the account is
// (its username) and where it is signed in. Both read plain, re-fetchable
// projections from `hostedHub/accountProfile`, so neither needs the step-up
// machinery the credential sections in `AccountSettings.tsx` run behind.

import {
  AtSignIcon,
  LogOutIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { HostedAccountSession } from "@ryco/client-runtime/authorization";

import {
  accountIdentity,
  changeAccountUsername,
  normalizeUsernameInput,
  refreshAccountProfile,
  refreshAccountSessions,
  revokeAccountSession,
  revokeOtherAccountSessions,
  useAccountProfileStore,
  USERNAME_MAX_LENGTH,
  usernameIssue,
} from "../../hostedHub/accountProfile";
import { useHostedHubStore } from "../../hostedHub/state";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

function roleLabel(role: string): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

/* ------------------------------------------------------------------ profile */

/**
 * The account's public identity: one username, the way a code host names an
 * account. The separate free-text display name is gone from this surface — an
 * account that still has only one (it predates usernames) is asked to pick a
 * username instead.
 */
export function ProfileSection() {
  const account = useHostedHubStore((state) => state.account);
  const profile = useAccountProfileStore((state) => state.profile);
  const status = useAccountProfileStore((state) => state.profileStatus);
  const identity = accountIdentity(profile, account?.displayName ?? null);
  const [editing, setEditing] = useState(false);
  const nowMs = useRelativeTimeTick(60_000);

  useEffect(() => {
    void refreshAccountProfile();
  }, []);

  const lockedUntil =
    profile?.usernameChangeAvailableAt != null && profile.usernameChangeAvailableAt > nowMs
      ? profile.usernameChangeAvailableAt
      : null;
  const joined = profile?.createdAt ?? account?.createdAt ?? null;

  return (
    <SettingsSection title="Profile" icon={<AtSignIcon aria-hidden className="size-3.5" />}>
      <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xl"
        >
          {identity.initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-base">{identity.handle}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
            {account ? <Badge variant="outline">{roleLabel(account.role)}</Badge> : null}
            {joined === null ? null : (
              <span>Member since {dateFormatter.format(new Date(joined))}</span>
            )}
          </p>
        </div>
      </div>

      {identity.needsUsername && !editing ? (
        <div className="border-border/60 border-t px-4 py-3.5 sm:px-5">
          <Alert variant="info">
            <AtSignIcon aria-hidden />
            <AlertTitle>Choose your username</AlertTitle>
            <AlertDescription>
              This account was created before usernames. Pick one to sign in with and to be known by
              on this Hub.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {status === "unsupported" ? null : (
        <SettingsRow
          title="Username"
          description={
            lockedUntil === null
              ? "Lowercase letters, numbers and underscores. You sign in with it and other people on this Hub see it."
              : `You can change it again on ${dateFormatter.format(new Date(lockedUntil))}.`
          }
          status={
            profile === null
              ? status === "error"
                ? "Could not load your profile."
                : "Loading…"
              : identity.needsUsername
                ? "Not chosen yet"
                : null
          }
          control={
            editing || profile === null ? (
              status === "error" ? (
                <Button size="xs" variant="outline" onClick={() => void refreshAccountProfile()}>
                  Retry
                </Button>
              ) : null
            ) : (
              <Button
                size="xs"
                variant={identity.needsUsername ? "default" : "outline"}
                aria-label={identity.needsUsername ? undefined : "Change username"}
                disabled={lockedUntil !== null}
                onClick={() => setEditing(true)}
              >
                {identity.needsUsername ? "Choose username" : "Change"}
              </Button>
            )
          }
        >
          {editing && profile !== null ? (
            <UsernameForm
              initial={identity.needsUsername ? "" : profile.username}
              onDone={() => setEditing(false)}
            />
          ) : null}
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function UsernameForm({
  initial,
  onDone,
}: {
  readonly initial: string;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const issue = usernameIssue(value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue || pending) return;
    if (value === initial) {
      onDone();
      return;
    }
    setPending(true);
    setRefusal(null);
    const result = await changeAccountUsername(value);
    setPending(false);
    if (result.ok) onDone();
    else setRefusal(result.message);
  };

  const error = refusal ?? (touched ? issue : null);

  return (
    <form className="pt-3 pb-3.5" onSubmit={(event) => void submit(event)}>
      <Label htmlFor="account-username" className="sr-only">
        New username
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 z-10 flex items-center text-muted-foreground text-sm"
          >
            @
          </span>
          <Input
            id="account-username"
            autoFocus
            value={value}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={USERNAME_MAX_LENGTH}
            disabled={pending}
            aria-invalid={error !== null}
            aria-describedby="account-username-hint"
            className={`[&_input]:pl-7 ${TOUCH_INPUT_CLASS_NAME}`}
            onChange={(event) => {
              setValue(normalizeUsernameInput(event.target.value));
              setRefusal(null);
            }}
          />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Spinner className="size-3.5" /> : null}
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      <p
        id="account-username-hint"
        role={error ? "alert" : undefined}
        className={`pt-2 text-xs ${error ? "text-destructive-foreground" : "text-muted-foreground"}`}
      >
        {error ?? "After a change you keep the new name for at least 14 days."}
      </p>
    </form>
  );
}

/* ----------------------------------------------------------------- sessions */

const METHOD_LABELS: Readonly<Record<string, string>> = {
  passkey: "passkey",
  password: "password",
  recovery_code: "recovery code",
  email_recovery: "email link",
  external_identity: "GitHub",
  github: "GitHub",
};

function sessionTitle(session: HostedAccountSession): string {
  if (session.clientLabel) return session.clientLabel;
  return session.kind === "native" ? "Ryco app" : "Web browser";
}

function sessionDetail(session: HostedAccountSession, nowMs: number): string {
  const method = session.method === null ? null : (METHOD_LABELS[session.method] ?? null);
  const parts = [
    session.current
      ? "Active now"
      : `Active ${formatRelativeTimeLabel(new Date(session.lastSeenAt).toISOString(), nowMs)}`,
    `Signed in ${dateFormatter.format(new Date(session.createdAt))}${
      method === null ? "" : ` with ${method}`
    }`,
  ];
  return parts.join(" · ");
}

/**
 * Every place the account is signed in, with a way to end each one.
 *
 * The current session has no button: ending it is signing out, which the
 * account menu already does and says.
 */
export function SessionsSection() {
  const sessions = useAccountProfileStore((state) => state.sessions);
  const status = useAccountProfileStore((state) => state.sessionsStatus);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [endingOthers, setEndingOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useRelativeTimeTick(60_000);

  useEffect(() => {
    void refreshAccountSessions();
  }, []);

  if (status === "unsupported") return null;

  const others = sessions.filter((session) => !session.current);

  const end = async (session: HostedAccountSession) => {
    setPendingId(session.id);
    setError(null);
    const result = await revokeAccountSession(session.id);
    setPendingId(null);
    if (!result.ok) setError(result.message);
  };

  const endOthers = async () => {
    setEndingOthers(true);
    setError(null);
    const result = await revokeOtherAccountSessions();
    setEndingOthers(false);
    setConfirmOthers(false);
    if (!result.ok) setError(result.message);
  };

  return (
    <SettingsSection
      title="Where you're signed in"
      icon={<MonitorSmartphoneIcon aria-hidden className="size-3.5" />}
      headerAction={
        others.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={endingOthers || pendingId !== null}
            onClick={() => setConfirmOthers(true)}
          >
            Sign out everywhere else
          </Button>
        ) : null
      }
    >
      {error ? (
        <div className="px-4 pt-3.5 sm:px-5">
          <Alert variant="error" aria-live="polite">
            <TriangleAlertIcon aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {sessions.length === 0 ? (
        <SettingsRow
          title={status === "error" ? "Could not load your sessions" : "Loading sessions…"}
          control={
            status === "error" ? (
              <Button size="xs" variant="outline" onClick={() => void refreshAccountSessions()}>
                Retry
              </Button>
            ) : null
          }
        />
      ) : (
        sessions.map((session) => {
          const Icon = session.kind === "native" ? SmartphoneIcon : MonitorIcon;
          return (
            <SettingsRow
              key={session.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{sessionTitle(session)}</span>
                  {session.current ? <Badge variant="success">This device</Badge> : null}
                </span>
              }
              description={sessionDetail(session, nowMs)}
              control={
                session.current ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Sign out ${sessionTitle(session)}`}
                    disabled={pendingId !== null || endingOthers}
                    onClick={() => void end(session)}
                  >
                    {pendingId === session.id ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <LogOutIcon aria-hidden />
                    )}
                    Sign out
                  </Button>
                )
              }
            />
          );
        })
      )}

      <AlertDialog
        open={confirmOthers}
        onOpenChange={(next) => {
          if (!endingOthers) setConfirmOthers(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere else?</AlertDialogTitle>
            <AlertDialogDescription>
              {others.length === 1
                ? "The other session ends right away."
                : `${others.length} other sessions end right away.`}{" "}
              This browser stays signed in. Those devices have to sign in again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button disabled={endingOthers} onClick={() => void endOthers()}>
              {endingOthers ? <Spinner className="size-3.5" /> : null}
              Sign out the others
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
