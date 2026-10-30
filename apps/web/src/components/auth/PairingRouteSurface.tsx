import type { AuthSessionState } from "@ryco/contracts";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { addSavedEnvironment } from "../../environments/runtime";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PHONE_ANCHORED_ACTIONS_CLASS_NAME } from "../mobile/phoneAnchoredActions";
import { PairingSurface } from "./PairingSurface";

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <PairingSurface>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Pair with this environment
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {describeAuthGate(auth.bootstrapMethods)}
      </p>

      <form
        className="mt-6 space-y-4 phone:flex phone:flex-1 phone:flex-col"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            Pairing token
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            // `Input` forwards `className` to its wrapper, so the phone touch
            // floor is applied to the control it wraps.
            className="phone:[&_input]:min-h-11"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder="Paste a one-time token or pairing secret"
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className={`flex flex-wrap gap-2 phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
          <Button className="phone:min-h-11" disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Pairing..." : "Continue"}
          </Button>
          <Button
            className="phone:min-h-11"
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>
    </PairingSurface>
  );
}

export function HostedPairingRouteSurface() {
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This one-time pairing token was already submitted. Request a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    try {
      const record = await addSavedEnvironment({
        label: request.label,
        host: request.host,
        pairingCode: request.token,
      });
      setStatus("paired");
      setMessage(`${record.label} is saved in this browser.`);
    } catch (error) {
      tokenSubmittedRef.current = false;
      setStatus("error");
      setCanRetry(true);
      setMessage(
        `${errorMessageFromUnknown(error)} If the backend accepted this one-time token, request a new pairing link before retrying.`,
      );
    }
  }, []);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  const request = hostedPairingRequestRef.current;

  return (
    <PairingSurface>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        {status === "paired"
          ? "Backend paired"
          : status === "error"
            ? "Pairing failed"
            : "Pairing backend"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
          Verify the backend is reachable from this browser, supports CORS for hosted clients, and
          is served over HTTPS when opening this page from HTTPS.
        </div>
      ) : null}

      <div
        className={`mt-6 flex flex-wrap gap-2 phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}
      >
        {status === "pairing" ? (
          <Button className="phone:min-h-11" disabled size="sm">
            Pairing...
          </Button>
        ) : canRetry ? (
          <Button
            className="phone:min-h-11"
            size="sm"
            onClick={() => void submitHostedPairingRequest()}
          >
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button
            className="phone:min-h-11"
            size="sm"
            variant="outline"
            onClick={() => (window.location.href = "/")}
          >
            Open app
          </Button>
        ) : null}
      </div>
    </PairingSurface>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
