import {
  HOSTED_IDENTITY_MAX_EMAIL_CHARS,
  HOSTED_IDENTITY_MAX_PASSWORD_CHARS,
  HOSTED_IDENTITY_MIN_PASSWORD_CHARS,
  HUB_USERNAME_MAX_CHARS,
  type ExternalIdentityPendingResponse,
  type PasswordLoginStartResponse,
  type PasswordResetVerifyResponse,
  type PublicSignupConfigResponse,
  type PublicSignupStartResponse,
  type PublicSignupVerifyRequest,
  type PublicSignupVerifyResponse,
} from "@ryco/contracts/hosted-identity";
import { KeyRoundIcon, Loader2Icon, MailIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { encodeBase64Url } from "../../hostedHub/base64url";
import type { HostedIdentityLink } from "../../hostedHub/hostedIdentityLinks";
import { hostedHubController } from "../../hostedHub/state";
import { PHONE_ANCHORED_ACTIONS_CLASS_NAME } from "../mobile/phoneAnchoredActions";
import { Button } from "../ui/button";
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { HubStepIndicator } from "./shell/HubStepIndicator";
import { TurnstileWidget } from "./TurnstileWidget";

type EnabledSignupConfig = Extract<PublicSignupConfigResponse, { readonly status: "enabled" }>;
export type ExternalIdentityPendingSignup = Extract<
  ExternalIdentityPendingResponse,
  { readonly status: "signup" }
>;
type SignupLinkToken = Extract<
  PublicSignupVerifyRequest["proof"],
  { readonly kind: "link_token" }
>["token"];
type SignupEmailCode = Extract<
  PublicSignupVerifyRequest["proof"],
  { readonly kind: "email_code" }
>["code"];

function identityError(cause: unknown, fallback: string): string {
  return cause instanceof HostedHubApiError ? cause.message : fallback;
}

function freshIdempotencyKey(): Parameters<
  typeof hostedHubApi.finishPublicSignupWithPassword
>[0]["idempotencyKey"] {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes) as Parameters<
    typeof hostedHubApi.finishPublicSignupWithPassword
  >[0]["idempotencyKey"];
}

export function usePublicSignupConfiguration(): {
  readonly config: PublicSignupConfigResponse | null;
  readonly loading: boolean;
} {
  const [config, setConfig] = useState<PublicSignupConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const operation = new AbortController();
    void hostedHubApi
      .getPublicSignupConfiguration(operation.signal)
      .then(setConfig)
      .catch(() => setConfig({ status: "disabled" }))
      .finally(() => {
        if (!operation.signal.aborted) setLoading(false);
      });
    return () => operation.abort();
  }, []);
  return { config, loading };
}

type SignupPending =
  | Pick<PublicSignupStartResponse, "attemptId" | "attemptSecret" | "expiresAt">
  | Pick<PublicSignupVerifyResponse, "attemptId" | "activationSecret" | "expiresAt">;

function isVerifiedSignup(
  value: SignupPending | null,
): value is Pick<PublicSignupVerifyResponse, "attemptId" | "activationSecret" | "expiresAt"> {
  return value !== null && "activationSecret" in value;
}

export function PublicSignupFlow({
  config,
  initialLink,
  onConsumeLink,
  onCancel,
}: {
  readonly config: EnabledSignupConfig | null;
  readonly initialLink: HostedIdentityLink | null;
  readonly onConsumeLink: () => void;
  readonly onCancel: () => void;
}) {
  const [stage, setStage] = useState<
    "details" | "check-email" | "verifying" | "credential" | "password"
  >(
    initialLink?.kind === "signup-verification" ||
      initialLink?.kind === "invalid-signup-verification"
      ? "verifying"
      : "details",
  );
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [antiBotToken, setAntiBotToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = useRef<SignupPending | null>(null);
  const linkStarted = useRef(false);

  useEffect(() => {
    if (linkStarted.current || initialLink === null) return;
    linkStarted.current = true;
    if (initialLink.kind !== "signup-verification") {
      if (initialLink.kind === "invalid-signup-verification") {
        setError("This verification link is incomplete or expired. Start signup again.");
        setStage("details");
      }
      return;
    }
    const operation = new AbortController();
    setPending(true);
    void hostedHubApi
      .verifyPublicSignup(
        {
          attemptId: initialLink.attemptId as Parameters<
            typeof hostedHubApi.verifyPublicSignup
          >[0]["attemptId"],
          attemptSecret: initialLink.attemptSecret as Parameters<
            typeof hostedHubApi.verifyPublicSignup
          >[0]["attemptSecret"],
          proof: {
            kind: "link_token",
            token: initialLink.token as SignupLinkToken,
          },
        },
        operation.signal,
      )
      .then((verified) => {
        signup.current = verified;
        setStage("credential");
      })
      .catch((cause) =>
        setError(identityError(cause, "This verification link could not be confirmed.")),
      )
      .finally(() => {
        onConsumeLink();
        if (!operation.signal.aborted) setPending(false);
      });
    return () => operation.abort();
  }, [initialLink, onConsumeLink]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || config === null) return;
    const assertion = config.antiBot.provider === "bypass" ? "development" : (antiBotToken ?? "");
    if (!assertion) {
      setError("Complete the anti-bot check before continuing.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const started = await hostedHubApi.startPublicSignup({
        username: username.trim().toLowerCase() as Parameters<
          typeof hostedHubApi.startPublicSignup
        >[0]["username"],
        email: email.trim().toLowerCase() as Parameters<
          typeof hostedHubApi.startPublicSignup
        >[0]["email"],
        antiBotAssertion: assertion,
      });
      signup.current = started;
      setStage("check-email");
    } catch (cause) {
      setError(identityError(cause, "Account creation is temporarily unavailable."));
    } finally {
      setPending(false);
    }
  };

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault();
    const current = signup.current;
    if (pending || current === null || !("attemptSecret" in current)) return;
    setPending(true);
    setError(null);
    try {
      const verified = await hostedHubApi.verifyPublicSignup({
        attemptId: current.attemptId,
        attemptSecret: current.attemptSecret,
        proof: {
          kind: "email_code",
          code: emailCode.trim() as SignupEmailCode,
        },
      });
      setEmailCode("");
      signup.current = verified;
      setStage("credential");
    } catch (cause) {
      setError(identityError(cause, "That email code could not be verified."));
    } finally {
      setPending(false);
    }
  };

  const finish = async (kind: "passkey" | "password") => {
    const current = signup.current;
    if (pending || !isVerifiedSignup(current)) return;
    if (kind === "password" && password !== passwordConfirmation) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const submittedPassword = password;
    setPassword("");
    setPasswordConfirmation("");
    try {
      const completed =
        kind === "passkey"
          ? await hostedHubApi.finishPublicSignupWithPasskey({
              attemptId: current.attemptId,
              activationSecret: current.activationSecret,
              idempotencyKey: freshIdempotencyKey(),
            })
          : await hostedHubApi.finishPublicSignupWithPassword({
              attemptId: current.attemptId,
              activationSecret: current.activationSecret,
              password: submittedPassword,
              idempotencyKey: freshIdempotencyKey(),
            });
      signup.current = null;
      await hostedHubController.adoptPublicBrowserIdentity(
        completed.identity,
        completed.recoveryCodes,
      );
    } catch (cause) {
      setError(identityError(cause, "Account creation did not complete."));
    } finally {
      setPending(false);
    }
  };

  // Signup is four steps and used to give no sign of it, so a person entering
  // an email code could not tell whether they were nearly finished or nearly
  // starting. `verifying` is not a step of its own — it is the mailbox step
  // completing itself from a link — so it reports as step 2.
  const signupStep =
    stage === "details" ? 1 : stage === "check-email" || stage === "verifying" ? 2 : 3;

  return (
    <div className="flex flex-1 flex-col">
      <HubStepIndicator
        step={signupStep}
        total={3}
        label={
          signupStep === 1
            ? "Your details"
            : signupStep === 2
              ? "Verify your email"
              : "Choose how you sign in"
        }
      />
      {stage === "details" ? (
        <form className="space-y-4" onSubmit={(event) => void start(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="hub-signup-username">Username</Label>
            <Input
              id="hub-signup-username"
              autoCapitalize="none"
              autoComplete="username"
              maxLength={HUB_USERNAME_MAX_CHARS}
              pattern="[A-Za-z0-9_]+"
              required
              value={username}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setUsername(event.currentTarget.value.toLowerCase())}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, and underscores.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-signup-email">Email</Label>
            <Input
              id="hub-signup-email"
              type="email"
              autoCapitalize="none"
              autoComplete="email"
              maxLength={HOSTED_IDENTITY_MAX_EMAIL_CHARS}
              required
              value={email}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
          {config?.antiBot.provider === "turnstile" ? (
            <TurnstileWidget
              siteKey={config.antiBot.siteKey}
              action="public_signup"
              onToken={setAntiBotToken}
            />
          ) : null}
          <FlowError value={error} />
          <FlowActions
            onCancel={onCancel}
            pending={pending}
            submitLabel="Send verification email"
            submitDisabled={config === null}
          />
        </form>
      ) : stage === "check-email" ? (
        <form className="space-y-4" onSubmit={(event) => void verifyCode(event)}>
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <MailIcon aria-hidden className="size-5 text-primary" />
            <p className="mt-2 text-sm font-medium">Check your email</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the six-digit code, or open the verification link on this device.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-signup-code">Verification code</Label>
            <Input
              id="hub-signup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              required
              value={emailCode}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setEmailCode(event.currentTarget.value)}
            />
          </div>
          <FlowError value={error} />
          <FlowActions onCancel={onCancel} pending={pending} submitLabel="Verify email" />
        </form>
      ) : stage === "password" ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void finish("password");
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="hub-signup-password">Password</Label>
            <Input
              id="hub-signup-password"
              type="password"
              autoComplete="new-password"
              minLength={HOSTED_IDENTITY_MIN_PASSWORD_CHARS}
              maxLength={HOSTED_IDENTITY_MAX_PASSWORD_CHARS}
              required
              value={password}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-signup-password-confirmation">Repeat password</Label>
            <Input
              id="hub-signup-password-confirmation"
              type="password"
              autoComplete="new-password"
              minLength={HOSTED_IDENTITY_MIN_PASSWORD_CHARS}
              maxLength={HOSTED_IDENTITY_MAX_PASSWORD_CHARS}
              required
              value={passwordConfirmation}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setPasswordConfirmation(event.currentTarget.value)}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            At least {HOSTED_IDENTITY_MIN_PASSWORD_CHARS} characters. Password sign-in always asks
            for an email or authenticator code too.
          </p>
          <FlowError value={error} />
          <FlowActions
            onCancel={() => setStage("credential")}
            pending={pending}
            submitLabel="Create account"
          />
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <ShieldCheckIcon aria-hidden className="size-5 text-primary" />
            <p className="mt-2 text-sm font-medium">
              {stage === "verifying" ? "Verifying your email…" : "Choose how you sign in"}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              A passkey is the strongest and easiest option. A password always requires a second
              factor on future sign-ins.
            </p>
          </div>
          <FlowError value={error} />
          <div className={`space-y-3 phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
            <Button
              type="button"
              size="lg"
              className="min-h-11 w-full"
              disabled={pending || stage === "verifying"}
              onClick={() => void finish("passkey")}
            >
              {pending ? (
                <Loader2Icon aria-hidden className="animate-spin" />
              ) : (
                <KeyRoundIcon aria-hidden />
              )}
              {pending ? "Creating passkey…" : "Create a passkey"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              disabled={pending || stage === "verifying"}
              onClick={() => setStage("password")}
            >
              Use a password instead
            </Button>
            <Button type="button" variant="ghost" className="min-h-11 w-full" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ExternalIdentitySignupFlow({
  pendingSignup,
  config,
  onCancel,
}: {
  readonly pendingSignup: ExternalIdentityPendingSignup;
  readonly config: EnabledSignupConfig | null;
  readonly onCancel: () => void;
}) {
  const [username, setUsername] = useState(pendingSignup.suggestedUsername ?? "");
  const [antiBotToken, setAntiBotToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || config === null) return;
    const assertion = config.antiBot.provider === "bypass" ? "development" : (antiBotToken ?? "");
    if (!assertion) {
      setError("Complete the anti-bot check before continuing.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const completed = await hostedHubApi.finishExternalIdentitySignup({
        provider: "github",
        username: username.trim().toLowerCase() as Parameters<
          typeof hostedHubApi.finishExternalIdentitySignup
        >[0]["username"],
        antiBotAssertion: assertion,
        idempotencyKey: freshIdempotencyKey(),
      });
      await hostedHubController.adoptPublicBrowserIdentity(
        completed.identity,
        completed.recoveryCodes,
      );
    } catch (cause) {
      setError(identityError(cause, "GitHub signup did not complete."));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-1 flex-col space-y-4" onSubmit={(event) => void finish(event)}>
      <HubStepIndicator step={1} total={1} label="Confirm your Ryco username" />
      <div className="rounded-xl border border-border bg-background/60 p-4">
        <ShieldCheckIcon aria-hidden className="size-5 text-primary" />
        <p className="mt-2 text-sm font-medium">GitHub verified</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {pendingSignup.displayName
            ? `${pendingSignup.displayName} authorized Ryco through GitHub. `
            : "GitHub authorized this account. "}
          Choose the public username Ryco should use. Nothing is created until you confirm.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="hub-external-signup-username">Username</Label>
        <Input
          id="hub-external-signup-username"
          autoCapitalize="none"
          autoComplete="username"
          maxLength={HUB_USERNAME_MAX_CHARS}
          pattern="[A-Za-z0-9_]+"
          required
          value={username}
          className={TOUCH_INPUT_CLASS_NAME}
          onChange={(event) => setUsername(event.currentTarget.value.toLowerCase())}
        />
        <p className="text-xs text-muted-foreground">
          GitHub suggested this name. You can change it before creating the account.
        </p>
      </div>
      {config?.antiBot.provider === "turnstile" ? (
        <TurnstileWidget
          siteKey={config.antiBot.siteKey}
          action="external_signup"
          onToken={setAntiBotToken}
        />
      ) : null}
      <FlowError value={error} />
      <FlowActions
        onCancel={onCancel}
        pending={pending}
        submitLabel="Create account with GitHub"
        submitDisabled={config === null}
      />
    </form>
  );
}

type LoginPending = Pick<
  PasswordLoginStartResponse,
  "attemptId" | "attemptSecret" | "factor" | "expiresAt"
>;

export function PasswordLoginFlow({
  onCancel,
  onUseRecoveryCode,
  onResetPassword,
}: {
  readonly onCancel: () => void;
  readonly onUseRecoveryCode: () => void;
  readonly onResetPassword: () => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [attempt, setAttempt] = useState<LoginPending | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (attempt === null) {
        const result = await hostedHubApi.startPasswordLogin({
          identifier: identifier.trim().toLowerCase() as Parameters<
            typeof hostedHubApi.startPasswordLogin
          >[0]["identifier"],
          password,
        });
        setPassword("");
        setAttempt(result);
      } else {
        const identity = await hostedHubApi.finishPasswordLogin({
          attemptId: attempt.attemptId,
          attemptSecret: attempt.attemptSecret,
          factor: attempt.factor,
          code: code.trim(),
        } as Parameters<typeof hostedHubApi.finishPasswordLogin>[0]);
        setCode("");
        await hostedHubController.adoptPublicBrowserIdentity(identity);
      }
    } catch (cause) {
      setError(identityError(cause, "Password sign-in did not complete."));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="mt-6 flex flex-1 flex-col space-y-4" onSubmit={(event) => void submit(event)}>
      {attempt === null ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="hub-login-identifier">Username or verified email</Label>
            <Input
              id="hub-login-identifier"
              autoCapitalize="none"
              autoComplete="username"
              required
              value={identifier}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setIdentifier(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-login-password">Password</Label>
            <Input
              id="hub-login-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={HOSTED_IDENTITY_MAX_PASSWORD_CHARS}
              value={password}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="hub-login-second-factor">
            {attempt.factor === "totp" ? "Authenticator code" : "Email code"}
          </Label>
          <Input
            id="hub-login-second-factor"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            className={TOUCH_INPUT_CLASS_NAME}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
          <p className="text-xs text-muted-foreground">
            {attempt.factor === "totp"
              ? "Enter the current code from your authenticator app."
              : "We sent a six-digit code to your verified email address."}
          </p>
        </div>
      )}
      <FlowError value={error} />
      {attempt === null ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onUseRecoveryCode}>
            Use recovery code
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onResetPassword}>
            Forgot password?
          </Button>
        </div>
      ) : null}
      <FlowActions
        onCancel={attempt === null ? onCancel : () => setAttempt(null)}
        pending={pending}
        submitLabel={attempt === null ? "Continue" : "Sign in"}
      />
    </form>
  );
}

type ResetPending = Pick<
  PasswordResetVerifyResponse,
  "attemptId" | "attemptSecret" | "requiresTotp" | "expiresAt"
>;

export function PasswordResetFlow({
  initialLink,
  onConsumeLink,
  onCancel,
}: {
  readonly initialLink: HostedIdentityLink | null;
  readonly onConsumeLink: () => void;
  readonly onCancel: () => void;
}) {
  const [stage, setStage] = useState<
    "request" | "check-email" | "verifying" | "password" | "complete"
  >(
    initialLink?.kind === "password-reset" || initialLink?.kind === "invalid-password-reset"
      ? "verifying"
      : "request",
  );
  const [identifier, setIdentifier] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = useRef<ResetPending | null>(null);
  const linkStarted = useRef(false);

  const verifyToken = async (submittedToken: string, signal?: AbortSignal) => {
    const verified = await hostedHubApi.verifyPasswordReset(
      {
        token: submittedToken as Parameters<typeof hostedHubApi.verifyPasswordReset>[0]["token"],
      },
      signal,
    );
    reset.current = verified;
    setToken("");
    setStage("password");
  };

  useEffect(() => {
    if (linkStarted.current || initialLink === null) return;
    linkStarted.current = true;
    if (initialLink.kind !== "password-reset") {
      if (initialLink.kind === "invalid-password-reset") {
        setError("This reset link is incomplete or expired. Request a new one.");
        setStage("request");
      }
      return;
    }
    const operation = new AbortController();
    setPending(true);
    void verifyToken(initialLink.token, operation.signal)
      .catch((cause) => setError(identityError(cause, "This reset link could not be verified.")))
      .finally(() => {
        onConsumeLink();
        if (!operation.signal.aborted) setPending(false);
      });
    return () => operation.abort();
  }, [initialLink, onConsumeLink]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (stage === "request") {
        await hostedHubApi.requestPasswordReset({
          identifier: identifier.trim().toLowerCase() as Parameters<
            typeof hostedHubApi.requestPasswordReset
          >[0]["identifier"],
        });
        setStage("check-email");
      } else if (stage === "check-email") {
        await verifyToken(token.trim());
      } else if (stage === "password") {
        const current = reset.current;
        if (current === null) return;
        if (password !== passwordConfirmation) {
          setError("The passwords do not match.");
          return;
        }
        const submittedPassword = password;
        setPassword("");
        setPasswordConfirmation("");
        await hostedHubApi.finishPasswordReset({
          attemptId: current.attemptId,
          attemptSecret: current.attemptSecret,
          password: submittedPassword,
          factor: current.requiresTotp ? { kind: "totp", code: totpCode.trim() } : { kind: "none" },
        } as Parameters<typeof hostedHubApi.finishPasswordReset>[0]);
        setTotpCode("");
        reset.current = null;
        setStage("complete");
      }
    } catch (cause) {
      setError(identityError(cause, "Password reset did not complete."));
    } finally {
      setPending(false);
    }
  };

  // `verifying` is the mail token being confirmed on arrival, which is the
  // second step completing itself; `complete` is the outcome, not a step.
  const resetStep =
    stage === "request" ? 1 : stage === "check-email" || stage === "verifying" ? 2 : 3;

  return (
    <form className="flex flex-1 flex-col space-y-4" onSubmit={(event) => void submit(event)}>
      {stage === "complete" ? null : (
        <HubStepIndicator
          step={resetStep}
          total={3}
          label={
            resetStep === 1
              ? "Find your account"
              : resetStep === 2
                ? "Check your email"
                : "Set a new password"
          }
        />
      )}
      {stage === "request" ? (
        <div className="space-y-1.5">
          <Label htmlFor="hub-reset-identifier">Username or verified email</Label>
          <Input
            id="hub-reset-identifier"
            autoCapitalize="none"
            autoComplete="username"
            required
            value={identifier}
            className={TOUCH_INPUT_CLASS_NAME}
            onChange={(event) => setIdentifier(event.currentTarget.value)}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            If the account is eligible, its verified address receives a single-use reset link.
          </p>
        </div>
      ) : stage === "check-email" ? (
        <>
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <MailIcon aria-hidden className="size-5 text-primary" />
            <p className="mt-2 text-sm font-medium">Check your email</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Open the reset link, or paste its token below.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-reset-token">Reset token</Label>
            <Input
              id="hub-reset-token"
              type="password"
              autoComplete="one-time-code"
              maxLength={64}
              required
              value={token}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
          </div>
        </>
      ) : stage === "password" ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="hub-reset-password">New password</Label>
            <Input
              id="hub-reset-password"
              type="password"
              autoComplete="new-password"
              minLength={HOSTED_IDENTITY_MIN_PASSWORD_CHARS}
              maxLength={HOSTED_IDENTITY_MAX_PASSWORD_CHARS}
              required
              value={password}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hub-reset-password-confirmation">Repeat password</Label>
            <Input
              id="hub-reset-password-confirmation"
              type="password"
              autoComplete="new-password"
              minLength={HOSTED_IDENTITY_MIN_PASSWORD_CHARS}
              maxLength={HOSTED_IDENTITY_MAX_PASSWORD_CHARS}
              required
              value={passwordConfirmation}
              className={TOUCH_INPUT_CLASS_NAME}
              onChange={(event) => setPasswordConfirmation(event.currentTarget.value)}
            />
          </div>
          {reset.current?.requiresTotp ? (
            <div className="space-y-1.5">
              <Label htmlFor="hub-reset-totp">Authenticator code</Label>
              <Input
                id="hub-reset-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={totpCode}
                className={TOUCH_INPUT_CLASS_NAME}
                onChange={(event) => setTotpCode(event.currentTarget.value)}
              />
            </div>
          ) : null}
        </>
      ) : stage === "complete" ? (
        <div className="rounded-xl border border-border bg-background/60 p-4">
          <ShieldCheckIcon aria-hidden className="size-5 text-primary" />
          <p className="mt-2 text-sm font-medium">Password changed</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Every previous session was revoked. Sign in again with the new password and its normal
            second factor.
          </p>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying your reset link…
        </p>
      )}
      <FlowError value={error} />
      {stage === "complete" ? (
        <div className={`phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
          <Button type="button" className="min-h-11 w-full" onClick={onCancel}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <FlowActions
          onCancel={onCancel}
          pending={pending}
          submitLabel={
            stage === "request"
              ? "Send reset email"
              : stage === "check-email"
                ? "Verify reset token"
                : stage === "password"
                  ? "Change password"
                  : "Verifying…"
          }
          submitDisabled={stage === "verifying"}
        />
      )}
    </form>
  );
}

export function RecoveryCodeFlow({ onCancel }: { readonly onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const submittedCode = code;
    setCode("");
    try {
      await hostedHubController.signInWithRecoveryCode(submittedCode);
    } catch (cause) {
      setError(identityError(cause, "That recovery code could not be used."));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="mt-6 flex flex-1 flex-col space-y-4" onSubmit={(event) => void submit(event)}>
      <div className="space-y-1.5">
        <Label htmlFor="hub-login-recovery-code">Recovery code</Label>
        <Input
          id="hub-login-recovery-code"
          type="password"
          autoComplete="one-time-code"
          required
          maxLength={128}
          value={code}
          className={TOUCH_INPUT_CLASS_NAME}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
      </div>
      <FlowError value={error} />
      <FlowActions onCancel={onCancel} pending={pending} submitLabel="Use recovery code" />
    </form>
  );
}

function FlowError({ value }: { readonly value: string | null }) {
  return value ? (
    <p role="alert" className="text-sm text-destructive">
      {value}
    </p>
  ) : null;
}

function FlowActions({
  onCancel,
  pending,
  submitLabel,
  submitDisabled = false,
}: {
  readonly onCancel: () => void;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly submitDisabled?: boolean;
}) {
  return (
    <div className={`space-y-3 phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
      <Button
        type="submit"
        size="lg"
        className="min-h-11 w-full"
        disabled={pending || submitDisabled}
      >
        {pending ? (
          <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : null}
        {pending ? "Working…" : submitLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 w-full"
        disabled={pending}
        onClick={onCancel}
      >
        Back
      </Button>
    </div>
  );
}
