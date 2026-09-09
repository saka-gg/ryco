import { getHostedHubApi } from "@ryco/client-runtime/authorization";
import { encodeBase64Url } from "@ryco/client-runtime/relay";
import type * as HostedIdentity from "@ryco/contracts/hosted-identity";
import { getMobileHostedUnavailableReason } from "../../hostedHub/runtimeAvailability";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SourceControlIcon } from "../../components/SourceControlIcon";
import {
  checkHubCapabilityWithTimeout,
  createHubCapabilityClient,
  type HubCapability,
} from "../../hostedHub/hubCapability";
import {
  clearMobileHubProfile,
  createHubProfile,
  readCachedMobileHubProfile,
  saveMobileHubProfile,
  type HubProfile,
} from "../../hostedHub/hubProfile";
import { invalidateMobileHostedRuntime } from "../../hostedHub/runtime";
import { getMobileHostedHttpClient } from "../../hostedHub/runtimeConfig";
import {
  ensureMobileHostedSession,
  hostedHubController,
  hostedHubStore,
  useHostedAccountStore,
} from "../../hostedHub/state";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobileNativeAuthorization } from "../../platform/nativeAuthorization";
import { isMobileDevelopmentBuild, readMobileHostedConfig } from "../../platform/config";
import { mobileKV } from "../../platform/kv";
import { mobileSecretKV } from "../../platform/secretKv";
import {
  clearMobileHostedSessionToken,
  mobileSessionCredentials,
} from "../../platform/sessionCredentials";
import { HubDomainEditor } from "../settings/HubDomainEditor";
import {
  deriveHostedBrowserSignInAction,
  deriveHostedProviderSignInActions,
} from "../hostedHub/hostedAuthModel";
import {
  createNativeIdentityCompletionJournal,
  type NativeIdentityCompletionJournal,
} from "./completionJournal";
import { cancelVerifiedEmailAttempt } from "./nativeIdentityCancellation";
import {
  mailboxCodePrompt,
  PRIVATE_MAILBOX_PRESENTATION,
  PRIVATE_RESET_MAILBOX_PRESENTATION,
  passwordResetMailboxPresentation,
} from "./nativeIdentityPresentation";
import {
  createNativeIdentityTransactionStore,
  type NativeIdentityTransactionRecord,
} from "./nativeIdentityTransaction";
import { NATIVE_IDENTITY_TURNSTILE_ACTIONS, TurnstileChallenge } from "./TurnstileChallenge";

type Activation = {
  readonly attemptId: HostedIdentity.NativeIdentityAttemptId;
  readonly attemptSecret: HostedIdentity.NativeIdentityEmailStartResponse["attemptSecret"];
  readonly activationSecret: HostedIdentity.NativeIdentityEmailVerifyResponse["activationSecret"];
  readonly expiresAt: number;
};

type PasswordScreen = {
  readonly name: "password";
  readonly identifier: string;
  readonly purpose: "login" | "signup";
} & Partial<Activation>;

type Screen =
  | { readonly name: "entry" }
  | {
      readonly name: "mailbox";
      readonly attemptId: HostedIdentity.NativeIdentityAttemptId;
      readonly attemptSecret: HostedIdentity.NativeIdentityEmailStartResponse["attemptSecret"];
      readonly expiresAt: number;
      readonly presentation: string;
    }
  | PasswordScreen
  | ({ readonly name: "username" } & Activation)
  | ({ readonly name: "credential" } & Activation)
  | {
      readonly name: "factor";
      readonly factor: "totp" | "email_code";
      readonly attemptId: HostedIdentity.NativeIdentityLoginAttemptId;
      readonly attemptSecret: HostedIdentity.NativeIdentityPasswordStartResponse["attemptSecret"];
      readonly expiresAt: number;
    }
  | { readonly name: "recovery" }
  | {
      readonly name: "reset-request";
      readonly previous: PasswordScreen;
    }
  | {
      readonly name: "reset-mailbox";
      readonly attemptId: HostedIdentity.NativeIdentityResetAttemptId;
      readonly attemptSecret: HostedIdentity.NativeIdentityPasswordResetResponse["attemptSecret"];
      readonly expiresAt: number;
      readonly presentation: string;
    }
  | {
      readonly name: "reset-password";
      readonly attemptId: HostedIdentity.NativeIdentityResetAttemptId;
      readonly resetSecret: HostedIdentity.NativeIdentityPasswordResetVerifyResponse["resetSecret"];
      readonly attemptSecret: HostedIdentity.NativeIdentityPasswordResetResponse["attemptSecret"];
      readonly requiresTotp: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly name: "recovery-codes";
      readonly journal: Extract<
        NativeIdentityCompletionJournal,
        { readonly phase: "recovery-pending" }
      >;
    };

const logo = require("../../../../../assets/logo_letter_only.svg");
const completionJournal = createNativeIdentityCompletionJournal({
  secretKV: mobileSecretKV,
  sessionCredentials: mobileSessionCredentials,
});
const transactionStore = createNativeIdentityTransactionStore(mobileSecretKV);
const SESSION_SETUP_WAIT_MS = 8_000;

function boundedError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return "";
  }
  return "Ryco could not complete that request. Check the details and try again.";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(value);
}

async function idempotencyKey(): Promise<string> {
  return encodeBase64Url(await mobileNativeAuthorization.randomBytes(32));
}

async function waitForSessionSetup(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ensureMobileHostedSession(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_SETUP_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function screenFromRecord(record: NativeIdentityTransactionRecord): Screen {
  if (record.kind === "signup") {
    if (record.step === "mailbox" && record.attemptSecret) {
      return {
        name: "mailbox",
        attemptId: record.attemptId as HostedIdentity.NativeIdentityAttemptId,
        attemptSecret:
          record.attemptSecret as HostedIdentity.NativeIdentityEmailStartResponse["attemptSecret"],
        expiresAt: record.expiresAt,
        presentation: record.presentation,
      };
    }
    if (record.activationSecret) {
      const activation = {
        attemptId: record.attemptId as HostedIdentity.NativeIdentityAttemptId,
        attemptSecret:
          record.attemptSecret as HostedIdentity.NativeIdentityEmailStartResponse["attemptSecret"],
        activationSecret:
          record.activationSecret as HostedIdentity.NativeIdentityEmailVerifyResponse["activationSecret"],
        expiresAt: record.expiresAt,
      };
      return record.step === "username"
        ? { name: "username", ...activation }
        : { name: "credential", ...activation };
    }
  }
  if (record.kind === "password-login") {
    return {
      name: "factor",
      factor: record.presentation,
      attemptId: record.attemptId as HostedIdentity.NativeIdentityLoginAttemptId,
      attemptSecret:
        record.attemptSecret as HostedIdentity.NativeIdentityPasswordStartResponse["attemptSecret"],
      expiresAt: record.expiresAt,
    };
  }
  if (record.kind === "verified-email-login") {
    return {
      name: "password",
      identifier: "",
      purpose: "login",
      attemptId: record.attemptId as HostedIdentity.NativeIdentityAttemptId,
      attemptSecret:
        record.attemptSecret as HostedIdentity.NativeIdentityEmailStartResponse["attemptSecret"],
      activationSecret:
        record.activationSecret as HostedIdentity.NativeIdentityEmailVerifyResponse["activationSecret"],
      expiresAt: record.expiresAt,
    };
  }
  if (record.kind === "password-reset") {
    if (record.step === "mailbox" && record.attemptSecret) {
      return {
        name: "reset-mailbox",
        attemptId: record.attemptId as HostedIdentity.NativeIdentityResetAttemptId,
        attemptSecret:
          record.attemptSecret as HostedIdentity.NativeIdentityPasswordResetResponse["attemptSecret"],
        expiresAt: record.expiresAt,
        presentation: record.presentation,
      };
    }
    if (record.step === "new-password" && record.resetSecret) {
      return {
        name: "reset-password",
        attemptId: record.attemptId as HostedIdentity.NativeIdentityResetAttemptId,
        resetSecret:
          record.resetSecret as HostedIdentity.NativeIdentityPasswordResetVerifyResponse["resetSecret"],
        attemptSecret:
          record.attemptSecret as HostedIdentity.NativeIdentityPasswordResetResponse["attemptSecret"],
        requiresTotp: record.requiresTotp === true,
        expiresAt: record.expiresAt,
      };
    }
  }
  return { name: "entry" };
}

function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly quiet?: boolean;
  readonly icon?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-13.5 flex-row items-center justify-center gap-2.5 rounded-full px-5 active:scale-[0.985] disabled:opacity-40",
        props.quiet ? "border border-border bg-card" : "bg-primary",
      )}
    >
      {props.icon}
      <Text
        className={cn(
          "text-base font-ryco-bold",
          props.quiet ? "text-foreground" : "text-primary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function EntryOption(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-60"
    >
      <Text className="text-[13px] font-ryco-medium text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

export function NativeIdentityScreen() {
  const navigation = useNavigation();
  const logoColor = useThemeColor("--color-foreground");
  const providerIconColor = useThemeColor("--color-foreground");
  const buildConfig = useMemo(readMobileHostedConfig, []);
  const development = isMobileDevelopmentBuild();
  const [screen, setScreen] = useState<Screen>({ name: "entry" });
  const [capability, setCapability] = useState<HubCapability | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [secondarySecret, setSecondarySecret] = useState("");
  const [antiBotToken, setAntiBotToken] = useState<string | null>(null);
  const [pendingMailToken, setPendingMailToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [profileRefreshRevision, setProfileRefreshRevision] = useState(0);
  const capabilityGeneration = useRef(0);
  const [profile, setProfile] = useState<HubProfile | null>(() => {
    const saved = readCachedMobileHubProfile();
    return saved === undefined
      ? null
      : (saved ??
          (buildConfig
            ? createHubProfile({
                origin: buildConfig.hubOrigin,
                label: "Ryco Hub",
                allowInsecure: development,
              })
            : null));
  });
  const externalIdentityConfiguration = useHostedAccountStore(
    (state) => state.externalIdentityConfiguration,
  );
  const browserSignInAction = deriveHostedBrowserSignInAction();
  const externalProviderActions = deriveHostedProviderSignInActions(externalIdentityConfiguration);

  const origin = profile?.origin ?? buildConfig?.hubOrigin ?? null;
  const nativePolicy = capability?.nativeIdentity;
  const normalizedIdentifier = identifier.trim().toLocaleLowerCase();
  const needsEntryAntiBot =
    isEmail(normalizedIdentifier) && nativePolicy?.email.antiBot.provider === "turnstile";
  const needsResetAntiBot =
    screen.name === "reset-request" && nativePolicy?.email.antiBot.provider === "turnstile";

  const refreshCapability = async (requestedOrigin: string | null = origin) => {
    const issued = ++capabilityGeneration.current;
    setBusy(true);
    setError(null);
    try {
      // Session restoration may still be waiting on an unreachable endpoint.
      // Native identity only needs the already-configured authenticated client,
      // so never let that independent restore keep the blocker inert forever.
      await waitForSessionSetup();
      if (issued !== capabilityGeneration.current) return;
      if (getMobileHostedUnavailableReason() === "credential-storage") {
        setCapability(null);
        setError("Your saved sign-in is temporarily locked. Unlock your device and retry.");
        return;
      }
      if (getMobileHostedUnavailableReason() === "device-security") {
        setCapability(null);
        setError(
          "Native sign-in needs this device's hardware security key. Unlock your device and retry. If this device cannot provide a hardware key, use another supported device.",
        );
        return;
      }
      // Provider policy is additive. A slow/old external-identity endpoint must
      // never hold the established passkey/password/recovery surface hostage.
      void hostedHubController.refreshExternalIdentityConfiguration({ force: true });
      if (requestedOrigin === null) throw new Error("missing origin");
      const http = getMobileHostedHttpClient();
      if (http === null) throw new Error("missing client");
      const result = await checkHubCapabilityWithTimeout(
        createHubCapabilityClient(http),
        requestedOrigin,
      );
      if (issued !== capabilityGeneration.current) return;
      if (result.status !== "compatible" || result.capability.nativeIdentity === undefined) {
        setCapability(null);
        setError(
          result.status === "incompatible" && result.reason === "unreachable"
            ? "Ryco could not reach native account access on this Hub. Try again."
            : "This Hub is not ready for native account access.",
        );
      } else {
        setCapability(result.capability);
      }
    } catch {
      if (issued !== capabilityGeneration.current) return;
      setCapability(null);
      setError("Ryco could not reach native account access on this Hub. Try again.");
    } finally {
      if (issued === capabilityGeneration.current) setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const journal = await completionJournal.read();
        if (!active) return;
        if (journal?.phase === "recovery-pending") {
          setScreen({ name: "recovery-codes", journal });
        } else if (journal?.phase === "credential-committed") {
          if (await completionJournal.commitCredential(journal)) {
            await hostedHubController.bootstrap();
          } else if (active) {
            setError("Ryco could not save the Hub credential. Try again.");
          }
        } else {
          const transaction = await transactionStore.read();
          if (active && transaction) setScreen(screenFromRecord(transaction));
        }
      } catch {
        if (!active) return;
        setBusy(false);
        setError(
          "Secure credential storage is unavailable in this build. Pair a machine directly or use a correctly signed build.",
        );
        return;
      }
      if (active) await refreshCapability(origin);
    })();
    return () => {
      active = false;
      capabilityGeneration.current += 1;
      setSecret("");
      setSecondarySecret("");
    };
  }, [origin, profileRefreshRevision]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setSecret("");
        setSecondarySecret("");
        setAntiBotToken(null);
        setPendingMailToken(null);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let active = true;
    const capture = (url: string | null) => {
      if (!active || url === null) return;
      try {
        const parsed = new URL(url);
        if (parsed.searchParams.has("token")) {
          setError("Email links must keep their token in the protected fragment.");
          return;
        }
        const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
        if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) setPendingMailToken(token);
      } catch {
        // Unrelated or malformed links never enter the identity transaction.
      }
    };
    void Linking.getInitialURL().then(capture);
    const subscription = Linking.addEventListener("url", (event) => capture(event.url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      const message = boundedError(cause);
      if (message) setError(message);
    } finally {
      setSecret("");
      setSecondarySecret("");
      setBusy(false);
    }
  };

  const persistTransaction = async (record: NativeIdentityTransactionRecord) => {
    if (!(await transactionStore.write(record))) {
      throw new Error("transaction persistence failed");
    }
  };

  const complete = async (response: {
    readonly token: string;
    readonly identity: HostedIdentity.HubSessionIdentity;
    readonly recoveryCodes?: ReadonlyArray<string>;
  }) => {
    if (origin === null) throw new Error("missing origin");
    const journal: NativeIdentityCompletionJournal = response.recoveryCodes?.length
      ? {
          version: 1,
          phase: "recovery-pending",
          origin,
          token: response.token,
          identity: response.identity,
          recoveryCodes: response.recoveryCodes,
        }
      : {
          version: 1,
          phase: "credential-committed",
          origin,
          token: response.token,
          identity: response.identity,
        };
    if (!(await completionJournal.stage(journal))) throw new Error("journal persistence failed");
    await transactionStore.clear();
    if (journal.phase === "recovery-pending") {
      setScreen({ name: "recovery-codes", journal });
      return;
    }
    if (!(await completionJournal.commitCredential(journal))) {
      throw new Error("credential persistence failed");
    }
    await hostedHubController.bootstrap();
  };

  const antiBotAssertion = (): string | null => {
    if (nativePolicy?.email.antiBot.provider === "bypass") return "development";
    return antiBotToken;
  };

  const start = () =>
    void run(async () => {
      const value = identifier.trim().toLocaleLowerCase();
      if (isEmail(value)) {
        const assertion = antiBotAssertion();
        if (!assertion) throw new Error("anti-bot required");
        const response = await getHostedHubApi().startNativeIdentityEmail({
          email: value as HostedIdentity.HubNormalizedEmail,
          antiBotAssertion: assertion,
        });
        const next: Screen = {
          name: "mailbox",
          attemptId: response.attemptId,
          attemptSecret: response.attemptSecret,
          expiresAt: response.expiresAt,
          presentation: value,
        };
        await persistTransaction({
          version: 1,
          kind: "signup",
          step: "mailbox",
          origin: origin!,
          attemptId: response.attemptId,
          attemptSecret: response.attemptSecret,
          expiresAt: response.expiresAt,
          presentation: PRIVATE_MAILBOX_PRESENTATION,
        });
        setAntiBotToken(null);
        setScreen(next);
        return;
      }
      if (!isUsername(value)) throw new Error("invalid identifier");
      if (!nativePolicy?.login.methods.includes("password")) {
        throw new Error("password login unavailable");
      }
      setScreen({ name: "password", identifier: value, purpose: "login" });
    });

  const verifyMailbox = (reset = false, linkToken?: string) =>
    void run(async () => {
      if (screen.name !== (reset ? "reset-mailbox" : "mailbox")) return;
      const proof = linkToken
        ? ({ kind: "link_token", token: linkToken as never } as const)
        : ({ kind: "email_code", code: secret as never } as const);
      if (reset && screen.name === "reset-mailbox") {
        const response = await getHostedHubApi().verifyNativeIdentityPasswordReset({
          attemptId: screen.attemptId,
          attemptSecret: screen.attemptSecret,
          proof,
        });
        await persistTransaction({
          version: 1,
          kind: "password-reset",
          step: "new-password",
          origin: origin!,
          attemptId: response.attemptId,
          attemptSecret: screen.attemptSecret,
          resetSecret: response.resetSecret,
          requiresTotp: response.requiresTotp,
          expiresAt: response.expiresAt,
          presentation: "verified",
        });
        setScreen({
          name: "reset-password",
          attemptId: response.attemptId,
          attemptSecret: screen.attemptSecret,
          resetSecret: response.resetSecret,
          requiresTotp: response.requiresTotp,
          expiresAt: response.expiresAt,
        });
        return;
      }
      if (screen.name !== "mailbox") return;
      const response = await getHostedHubApi().verifyNativeIdentityEmail({
        attemptId: screen.attemptId,
        attemptSecret: screen.attemptSecret,
        proof,
      });
      const activation = {
        attemptId: response.attemptId,
        attemptSecret: screen.attemptSecret,
        activationSecret: response.activationSecret,
        expiresAt: response.expiresAt,
      };
      if (response.status === "existing_account") {
        if (!nativePolicy?.login.methods.includes("password")) {
          await cancelVerifiedEmailAttempt(getHostedHubApi(), response);
          await transactionStore.clear();
          setScreen({ name: "entry" });
          setError("This Hub does not currently offer password login.");
          return;
        }
        await persistTransaction({
          version: 1,
          kind: "verified-email-login",
          step: "password",
          origin: origin!,
          ...activation,
          presentation: "verified",
        });
        setScreen({ name: "password", identifier: "", purpose: "login", ...activation });
      } else {
        if (nativePolicy?.signup.status !== "enabled") {
          await cancelVerifiedEmailAttempt(getHostedHubApi(), response);
          await transactionStore.clear();
          setScreen({ name: "entry" });
          setError(
            "That email is not linked to an existing account. New account signup is currently closed.",
          );
          return;
        }
        await persistTransaction({
          version: 1,
          kind: "signup",
          step: "username",
          origin: origin!,
          ...activation,
          presentation: "verified",
        });
        setScreen({ name: "username", ...activation });
      }
    });

  useEffect(() => {
    if (
      pendingMailToken === null ||
      busy ||
      (screen.name !== "mailbox" && screen.name !== "reset-mailbox")
    ) {
      return;
    }
    const token = pendingMailToken;
    setPendingMailToken(null);
    verifyMailbox(screen.name === "reset-mailbox", token);
    // `verifyMailbox` is intentionally action-local; screen/generation fencing
    // in the runtime rejects any late response after this effect re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pendingMailToken, screen.name]);

  const submitPassword = () =>
    void run(async () => {
      if (screen.name !== "password") return;
      const response = screen.activationSecret
        ? await getHostedHubApi().startNativeIdentityPasswordLogin({
            kind: "verified_email",
            attemptId: screen.attemptId!,
            activationSecret: screen.activationSecret,
            password: secret,
          })
        : await getHostedHubApi().startNativeIdentityPasswordLogin({
            kind: "username",
            username: screen.identifier as HostedIdentity.HubUsername,
            password: secret,
            ...(antiBotAssertion() ? { antiBotAssertion: antiBotAssertion()! } : {}),
          });
      await persistTransaction({
        version: 1,
        kind: "password-login",
        step: "factor",
        origin: origin!,
        attemptId: response.attemptId,
        attemptSecret: response.attemptSecret,
        expiresAt: response.expiresAt,
        presentation: response.factor,
      });
      setScreen({ name: "factor", ...response });
    });

  const restart = () =>
    void run(async () => {
      const cancellableScreen = screen.name === "reset-request" ? screen.previous : screen;
      const attempt =
        cancellableScreen.name === "mailbox" ||
        cancellableScreen.name === "factor" ||
        cancellableScreen.name === "reset-mailbox" ||
        cancellableScreen.name === "reset-password" ||
        cancellableScreen.name === "username" ||
        cancellableScreen.name === "credential" ||
        (cancellableScreen.name === "password" &&
          cancellableScreen.attemptId &&
          cancellableScreen.attemptSecret)
          ? {
              attemptId: cancellableScreen.attemptId,
              attemptSecret: cancellableScreen.attemptSecret,
            }
          : null;
      if (attempt) {
        try {
          await getHostedHubApi().cancelNativeIdentityAttempt(attempt as never);
        } catch {
          // Local teardown still wins; the server attempt expires independently.
        }
      }
      await transactionStore.clear();
      setNotice(null);
      setScreen({ name: "entry" });
    });

  const replaceProfile = async (next: HubProfile) => {
    capabilityGeneration.current += 1;
    setEditorVisible(false);
    setBusy(true);
    setError(null);
    try {
      await clearMobileHostedSessionToken();
      await transactionStore.clear();
      await completionJournal.clear();
      await saveMobileHubProfile(mobileKV, next);
      invalidateMobileHostedRuntime();
      setProfile(next);
      setProfileRefreshRevision((revision) => revision + 1);
      setCapability(null);
      setScreen({ name: "entry" });
    } catch {
      setError("Ryco could not change the Hub safely. Directly paired machines remain unchanged.");
      setBusy(false);
    }
  };

  const useBuildDefault = async () => {
    if (!buildConfig) return;
    capabilityGeneration.current += 1;
    setEditorVisible(false);
    setBusy(true);
    setError(null);
    try {
      await clearMobileHostedSessionToken();
      await transactionStore.clear();
      await completionJournal.clear();
      await clearMobileHubProfile(mobileKV);
      invalidateMobileHostedRuntime();
      setProfile(
        createHubProfile({
          origin: buildConfig.hubOrigin,
          label: "Ryco Hub",
          allowInsecure: development,
        }),
      );
      setProfileRefreshRevision((revision) => revision + 1);
      setCapability(null);
      setScreen({ name: "entry" });
    } catch {
      setError(
        "Ryco could not restore the official Hub safely. Directly paired machines remain unchanged.",
      );
      setBusy(false);
    }
  };

  const title =
    screen.name === "entry"
      ? "Log in or sign up"
      : screen.name === "reset-request"
        ? "Reset your password"
        : screen.name === "mailbox" || screen.name === "reset-mailbox"
          ? "Check your email"
          : screen.name === "username"
            ? "Choose a username"
            : screen.name === "credential"
              ? "Secure your account"
              : screen.name === "factor"
                ? screen.factor === "totp"
                  ? "Enter your authenticator code"
                  : "Enter your email code"
                : screen.name === "recovery"
                  ? "Use a recovery code"
                  : screen.name === "reset-password"
                    ? "Set a new password"
                    : screen.name === "recovery-codes"
                      ? "Save your recovery codes"
                      : "Enter your password";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
    >
      <ScrollView
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
      >
        <View className="mx-auto w-full max-w-[420px]">
          <Image
            source={logo}
            contentFit="contain"
            tintColor={logoColor as string}
            accessibilityLabel="Ryco"
            style={{ width: 164, height: 164, alignSelf: "center", marginBottom: 32 }}
          />
          <Text className="text-center text-[30px] font-ryco-bold tracking-[-0.8px] text-foreground">
            {title}
          </Text>
          <Text className="mx-auto mt-2 max-w-[330px] text-center text-sm leading-relaxed text-foreground-muted">
            {screen.name === "recovery-codes"
              ? "Store these somewhere safe. Each code works once."
              : screen.name === "reset-request"
                ? "Verify the account before choosing a new password."
                : screen.name === "mailbox" || screen.name === "reset-mailbox"
                  ? mailboxCodePrompt(screen.presentation)
                  : "Native account access on Ryco Hub"}
          </Text>

          {error ? (
            <View className="mt-5">
              <ErrorBanner message={error} />
            </View>
          ) : null}
          {notice ? <Text className="mt-4 text-center text-sm text-success">{notice}</Text> : null}

          <View className="mt-7 gap-3">
            {screen.name === "entry" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Email or username"
                  placeholder="Email or username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  value={identifier}
                  onChangeText={setIdentifier}
                  returnKeyType="go"
                  onSubmitEditing={start}
                />
                {needsEntryAntiBot && nativePolicy && origin ? (
                  <TurnstileChallenge
                    origin={origin}
                    siteKey={nativePolicy.email.antiBot.siteKey}
                    action={NATIVE_IDENTITY_TURNSTILE_ACTIONS.emailStart}
                    onToken={setAntiBotToken}
                  />
                ) : null}
                <Action
                  label="Continue"
                  disabled={
                    busy ||
                    capability === null ||
                    normalizedIdentifier.length === 0 ||
                    (needsEntryAntiBot && antiBotToken === null)
                  }
                  onPress={start}
                />
                {!busy && capability === null ? (
                  <Action
                    label="Retry Hub connection"
                    quiet
                    onPress={() => void refreshCapability()}
                  />
                ) : null}
                <View className="my-1 flex-row items-center gap-3">
                  <View className="h-px flex-1 bg-border" />
                  <Text className="text-xs text-foreground-muted">or</Text>
                  <View className="h-px flex-1 bg-border" />
                </View>
                {externalProviderActions.map((providerAction) => (
                  <Action
                    key={providerAction.id}
                    label={providerAction.label}
                    quiet
                    icon={
                      providerAction.id === "sign-in-github" ? (
                        <SourceControlIcon
                          kind="github"
                          size={20}
                          color={providerIconColor as string}
                        />
                      ) : undefined
                    }
                    disabled={busy || providerAction.disabled}
                    onPress={() =>
                      void run(async () => {
                        await providerAction.run();
                        const hostedError = hostedHubStore.getState().errorMessage;
                        if (hostedError) setError(hostedError);
                      })
                    }
                  />
                ))}
                <Action
                  label={browserSignInAction.label}
                  quiet
                  icon={
                    <SymbolView
                      name={{ ios: "safari", android: "language" }}
                      size={19}
                      tintColor={providerIconColor as string}
                      type="monochrome"
                    />
                  }
                  disabled={busy || capability === null || browserSignInAction.disabled}
                  onPress={() =>
                    void run(async () => {
                      await browserSignInAction.run();
                      const hostedError = hostedHubStore.getState().errorMessage;
                      if (hostedError) setError(hostedError);
                    })
                  }
                />
                <View className="mt-0.5 items-center">
                  <Text className="text-[11px] font-ryco-medium text-foreground-muted">
                    Other options
                  </Text>
                  <View className="flex-row flex-wrap items-center justify-center gap-x-5">
                    {nativePolicy?.login.methods.includes("recovery_code") ? (
                      <EntryOption
                        label="Recovery code"
                        onPress={() => setScreen({ name: "recovery" })}
                      />
                    ) : null}
                    <EntryOption label="Different Hub" onPress={() => setEditorVisible(true)} />
                    <EntryOption
                      label="Add a machine"
                      onPress={() => navigation.navigate("ConnectionsNew" as never)}
                    />
                  </View>
                </View>
              </>
            ) : screen.name === "mailbox" || screen.name === "reset-mailbox" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Six-digit email code"
                  placeholder="000000"
                  keyboardType="number-pad"
                  maxLength={6}
                  value={secret}
                  onChangeText={setSecret}
                />
                <Action
                  label="Verify email"
                  disabled={busy || !/^\d{6}$/.test(secret)}
                  onPress={() => verifyMailbox(screen.name === "reset-mailbox")}
                />
                <Action label="Start over" quiet onPress={restart} />
              </>
            ) : screen.name === "username" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Username"
                  placeholder="username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={secret}
                  onChangeText={setSecret}
                />
                <Action
                  label="Continue"
                  disabled={busy || !isUsername(secret)}
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "username") return;
                      await getHostedHubApi().claimNativeIdentityUsername({
                        attemptId: screen.attemptId,
                        activationSecret: screen.activationSecret,
                        username: secret.toLocaleLowerCase() as HostedIdentity.HubUsername,
                      });
                      await persistTransaction({
                        version: 1,
                        kind: "signup",
                        step: "credential",
                        origin: origin!,
                        attemptId: screen.attemptId,
                        attemptSecret: screen.attemptSecret,
                        activationSecret: screen.activationSecret,
                        expiresAt: screen.expiresAt,
                        presentation: "verified",
                      });
                      setScreen({
                        name: "credential",
                        attemptId: screen.attemptId,
                        attemptSecret: screen.attemptSecret,
                        activationSecret: screen.activationSecret,
                        expiresAt: screen.expiresAt,
                      });
                    })
                  }
                />
                <Action label="Start over" quiet onPress={restart} />
              </>
            ) : screen.name === "credential" ? (
              <>
                <Action
                  label="Create a passkey"
                  disabled={
                    busy ||
                    nativePolicy?.signup.status !== "enabled" ||
                    !nativePolicy.signup.primaryCredentials.includes("passkey")
                  }
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "credential") return;
                      await complete(
                        await getHostedHubApi().finishNativeIdentitySignupWithPasskey({
                          attemptId: screen.attemptId,
                          activationSecret: screen.activationSecret,
                          idempotencyKey: (await idempotencyKey()) as never,
                        }),
                      );
                    })
                  }
                />
                {nativePolicy?.signup.status === "enabled" &&
                nativePolicy.signup.primaryCredentials.includes("password") ? (
                  <Action
                    label="Use a password instead"
                    quiet
                    onPress={() =>
                      setScreen({
                        name: "password",
                        identifier: "",
                        purpose: "signup",
                        attemptId: screen.attemptId,
                        attemptSecret: screen.attemptSecret,
                        activationSecret: screen.activationSecret,
                        expiresAt: screen.expiresAt,
                      })
                    }
                  />
                ) : null}
              </>
            ) : screen.name === "reset-request" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Email or username"
                  placeholder="Email or username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  value={identifier}
                  onChangeText={setIdentifier}
                />
                {needsResetAntiBot && nativePolicy && origin ? (
                  <TurnstileChallenge
                    origin={origin}
                    siteKey={nativePolicy.email.antiBot.siteKey}
                    action={NATIVE_IDENTITY_TURNSTILE_ACTIONS.passwordReset}
                    onToken={setAntiBotToken}
                  />
                ) : null}
                <Action
                  label="Send reset code"
                  disabled={
                    busy ||
                    (!isEmail(normalizedIdentifier) && !isUsername(normalizedIdentifier)) ||
                    (needsResetAntiBot && antiBotToken === null)
                  }
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "reset-request") return;
                      const response = await getHostedHubApi().requestNativeIdentityPasswordReset({
                        identifier: normalizedIdentifier as HostedIdentity.HubLoginIdentifier,
                        ...(antiBotAssertion() ? { antiBotAssertion: antiBotAssertion()! } : {}),
                      });
                      await persistTransaction({
                        version: 1,
                        kind: "password-reset",
                        step: "mailbox",
                        origin: origin!,
                        attemptId: response.attemptId,
                        attemptSecret: response.attemptSecret,
                        expiresAt: response.expiresAt,
                        presentation: PRIVATE_RESET_MAILBOX_PRESENTATION,
                      });
                      setAntiBotToken(null);
                      setScreen({
                        name: "reset-mailbox",
                        ...response,
                        presentation: passwordResetMailboxPresentation(
                          normalizedIdentifier,
                          isEmail(normalizedIdentifier),
                        ),
                      });
                    })
                  }
                />
                <Action
                  label="Back"
                  quiet
                  onPress={() => {
                    setAntiBotToken(null);
                    setScreen(screen.previous);
                  }}
                />
              </>
            ) : screen.name === "password" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Password"
                  placeholder="Password"
                  secureTextEntry
                  autoCapitalize="none"
                  value={secret}
                  onChangeText={setSecret}
                />
                <Action
                  label={screen.purpose === "signup" ? "Create account" : "Log in"}
                  disabled={busy || secret.length < 12}
                  onPress={
                    screen.purpose === "signup"
                      ? () =>
                          void run(async () => {
                            await complete(
                              await getHostedHubApi().finishNativeIdentitySignupWithPassword({
                                attemptId: screen.attemptId!,
                                activationSecret: screen.activationSecret!,
                                password: secret,
                                idempotencyKey: (await idempotencyKey()) as never,
                              }),
                            );
                          })
                      : submitPassword
                  }
                />
                {nativePolicy?.recovery.recoveryCode &&
                nativePolicy.login.methods.includes("recovery_code") ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setScreen({ name: "recovery" })}
                    className="min-h-11 items-center justify-center rounded-full px-4 active:bg-subtle"
                  >
                    <Text className="text-sm font-ryco-bold text-foreground-muted">
                      Use a recovery code
                    </Text>
                  </Pressable>
                ) : null}
                {nativePolicy?.recovery.passwordReset ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setIdentifier((screen.identifier || identifier).trim().toLocaleLowerCase());
                      setAntiBotToken(null);
                      setScreen({ name: "reset-request", previous: screen });
                    }}
                    className="min-h-11 items-center justify-center rounded-full px-4 active:bg-subtle"
                  >
                    <Text className="text-sm font-ryco-bold text-foreground-muted">
                      Forgot password?
                    </Text>
                  </Pressable>
                ) : null}
                <Action label="Back" quiet onPress={restart} />
              </>
            ) : screen.name === "factor" ? (
              <>
                <AppTextInput
                  accessibilityLabel={
                    screen.factor === "totp" ? "Authenticator code" : "Email code"
                  }
                  placeholder="000000"
                  keyboardType="number-pad"
                  maxLength={6}
                  value={secret}
                  onChangeText={setSecret}
                />
                <Action
                  label="Log in"
                  disabled={busy || !/^\d{6}$/.test(secret)}
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "factor") return;
                      await complete(
                        await getHostedHubApi().finishNativeIdentityPasswordLogin({
                          attemptId: screen.attemptId,
                          attemptSecret: screen.attemptSecret,
                          factor: screen.factor,
                          code: secret as never,
                        }),
                      );
                    })
                  }
                />
                <Action label="Start over" quiet onPress={restart} />
              </>
            ) : screen.name === "recovery" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Recovery code"
                  placeholder="Recovery code"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  value={secret}
                  onChangeText={setSecret}
                />
                <Action
                  label="Use recovery code"
                  disabled={busy || secret.trim().length === 0}
                  onPress={() =>
                    void run(async () => {
                      await complete(
                        await getHostedHubApi().signInNativeIdentityWithRecoveryCode({
                          code: secret.trim(),
                          idempotencyKey: (await idempotencyKey()) as never,
                        }),
                      );
                    })
                  }
                />
                <Action label="Back" quiet onPress={restart} />
              </>
            ) : screen.name === "reset-password" ? (
              <>
                <AppTextInput
                  accessibilityLabel="New password"
                  placeholder="New password"
                  secureTextEntry
                  value={secret}
                  onChangeText={setSecret}
                />
                {screen.requiresTotp ? (
                  <AppTextInput
                    accessibilityLabel="Authenticator code"
                    placeholder="Authenticator code"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={secondarySecret}
                    onChangeText={setSecondarySecret}
                  />
                ) : null}
                <Action
                  label="Reset password"
                  disabled={
                    busy ||
                    secret.length < 12 ||
                    (screen.requiresTotp && !/^\d{6}$/.test(secondarySecret))
                  }
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "reset-password") return;
                      await getHostedHubApi().finishNativeIdentityPasswordReset({
                        attemptId: screen.attemptId,
                        resetSecret: screen.resetSecret,
                        password: secret,
                        factor: screen.requiresTotp
                          ? { kind: "totp", code: secondarySecret as never }
                          : { kind: "none" },
                      });
                      await transactionStore.clear();
                      setNotice("Password reset. Log in with your new password.");
                      setScreen({ name: "entry" });
                    })
                  }
                />
              </>
            ) : screen.name === "recovery-codes" ? (
              <>
                <View className="rounded-2xl bg-card p-4">
                  {screen.journal.recoveryCodes.map((code) => (
                    <Text key={code} selectable className="py-1 text-center font-mono text-base">
                      {code}
                    </Text>
                  ))}
                </View>
                <Action
                  label="I saved these codes"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      if (screen.name !== "recovery-codes") return;
                      const committed = await completionJournal.acknowledgeRecovery(screen.journal);
                      if (!committed || !(await completionJournal.commitCredential(committed))) {
                        throw new Error("credential persistence failed");
                      }
                      await hostedHubController.bootstrap();
                    })
                  }
                />
              </>
            ) : null}
          </View>

          {busy ? <ActivityIndicator className="mt-5" /> : null}
        </View>
      </ScrollView>

      <HubDomainEditor
        visible={editorVisible}
        currentProfile={profile}
        buildOrigin={buildConfig?.hubOrigin ?? null}
        allowInsecure={development}
        requireNativeIdentity
        onDismiss={() => setEditorVisible(false)}
        onSave={(next) => void replaceProfile(next)}
        onUseBuildDefault={profile && buildConfig ? () => void useBuildDefault() : null}
      />
    </KeyboardAvoidingView>
  );
}
