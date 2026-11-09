import type { AcpAgentSource } from "@ryco/contracts/acp-registry";
import type { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentApi } from "../../../connection/useEnvironmentApi";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { acpAuthMethodRow, type AcpAuthMethodRow } from "./providerInstancesModel";

type ServerApi = NonNullable<NonNullable<ReturnType<typeof useEnvironmentApi>>["server"]>;

/** The ACP sign-in methods of the machine's connection; `null` without one or on an older node. */
function authApi(api: ReturnType<typeof useEnvironmentApi>): {
  readonly methods: NonNullable<ServerApi["getAcpRegistryAuthMethods"]>;
  readonly authenticate: NonNullable<ServerApi["authenticateAcpRegistry"]>;
} | null {
  if (api === undefined || api.server === undefined) return null;
  const { getAcpRegistryAuthMethods, authenticateAcpRegistry } = api.server;
  if (getAcpRegistryAuthMethods === undefined || authenticateAcpRegistry === undefined) return null;
  return { methods: getAcpRegistryAuthMethods, authenticate: authenticateAcpRegistry };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

const NO_METHODS =
  "This agent advertises no sign-in methods. Set its credentials with its own setup, or as sensitive environment variables.";

/**
 * Signs an ACP agent in on its machine, after the web's ACP authentication: Check starts the agent
 * to list its sign-in methods; an agent-run one starts from here, others say what to set up. The
 * caller keys it by the agent's install, so a new agent starts over.
 */
export function AcpAgentAuthenticationRows(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly source: AcpAgentSource;
  readonly allowed: boolean;
  readonly readOnlyReason: string | null;
}) {
  const api = useEnvironmentApi(props.environmentId);
  const [methods, setMethods] = useState<ReadonlyArray<AcpAuthMethodRow> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    return () => {
      generation.current = current + 1;
    };
  }, []);

  const check = () => {
    const auth = authApi(api);
    if (auth === null || !props.allowed || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage(null);
    void auth
      .methods({ instanceId: props.instanceId })
      .then((result) => {
        if (generation.current !== current) return;
        setMethods(result.map(acpAuthMethodRow));
        if (result.length === 0) setMessage(NO_METHODS);
      })
      .catch((cause: unknown) => {
        if (generation.current === current) setMessage(errorMessage(cause, "The check failed."));
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const signIn = (method: AcpAuthMethodRow) => {
    const auth = authApi(api);
    if (auth === null || !props.allowed || busy || !method.runnable) return;
    const current = generation.current;
    setBusy(true);
    setMessage(null);
    void auth
      .authenticate({ instanceId: props.instanceId, methodId: method.id })
      .then((result) => {
        if (generation.current !== current) return;
        setMessage(
          result.authenticated
            ? "Signed in. Start a chat to check access."
            : "The agent did not finish signing in.",
        );
      })
      .catch((cause: unknown) => {
        if (generation.current === current) setMessage(errorMessage(cause, "Sign-in failed."));
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const unsupported = authApi(api) === null;
  const disabled = !props.allowed || busy || unsupported;
  const checkDetail = unsupported
    ? "Connect to the machine to check how this agent signs in."
    : props.allowed
      ? props.source === "local"
        ? "Starts the command on the machine to list its sign-in methods."
        : "Starts the agent on the machine to list its sign-in methods."
      : (props.readOnlyReason ?? undefined);
  return (
    <SettingsSection title="Sign-in" {...(message !== null ? { footer: message } : {})}>
      <SettingsRow
        first
        icon={{ ios: "person.badge.key", android: "key" }}
        label={busy ? "Working…" : "Check sign-in methods"}
        detail={checkDetail}
        disabled={disabled}
        onPress={check}
      />
      {(methods ?? []).map((method) => (
        <SettingsRow
          key={method.id}
          label={method.label}
          detail={method.detail}
          value={method.runnable ? "Sign in" : undefined}
          disabled={method.runnable && disabled}
          {...(method.runnable ? { onPress: () => signIn(method) } : {})}
        />
      ))}
    </SettingsSection>
  );
}
