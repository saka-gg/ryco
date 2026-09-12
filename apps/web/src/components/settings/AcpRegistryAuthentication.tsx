import { useEffect, useRef, useState } from "react";
import { type AcpRegistryAuthMethod, type ProviderInstanceId, WS_METHODS } from "@ryco/contracts";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import { useSettingsTarget } from "../../settingsTarget";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { Button } from "../ui/button";

function AcpRegistryAuthenticationContent({
  instanceId,
}: {
  readonly instanceId: ProviderInstanceId;
}) {
  const target = useSettingsTarget();
  const capability = useHostedRpcCapability(WS_METHODS.serverAuthenticateAcpRegistry);
  const server = target
    ? readEnvironmentApi(target.environmentId)?.server
    : ensureLocalApi().server;
  const allowed =
    capability.allowed &&
    (!target || (target.connected && target.canManage !== false && target.canMutate !== false));
  const [methods, setMethods] = useState<ReadonlyArray<AcpRegistryAuthMethod> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    return () => {
      generation.current = current + 1;
    };
  }, []);

  const run = async (methodId?: string) => {
    if (!server || !allowed || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (methodId === undefined) {
        if (!server.getAcpRegistryAuthMethods)
          throw new Error("This node does not support ACP authentication discovery.");
        const result = await server.getAcpRegistryAuthMethods({ instanceId });
        if (generation.current === current) {
          setMethods(result);
          if (result.length === 0)
            setMessage(
              "This agent does not advertise authentication methods. Configure credentials using its documented setup or the sensitive environment variables above.",
            );
        }
      } else {
        const method = methods?.find((entry) => entry.id === methodId);
        if (!method || method.type === "env_var" || method.type === "terminal") return;
        if (!server.authenticateAcpRegistry)
          throw new Error("This node does not support ACP authentication.");
        const result = await server.authenticateAcpRegistry({ instanceId, methodId });
        if (generation.current === current) {
          if (!result.authenticated) throw new Error("The agent did not complete authentication.");
          setMessage("Authentication completed. Start a session to verify access.");
        }
      }
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : "Authentication failed.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">Authentication</p>
        <p className="text-xs text-muted-foreground">
          Check starts the installed agent to discover its sign-in methods. Sign-in runs on this
          node and may require interaction on the host.
        </p>
      </div>
      <Button size="xs" variant="outline" disabled={!allowed || busy} onClick={() => void run()}>
        {busy ? "Working…" : "Check authentication methods"}
      </Button>
      {methods?.map((method) => (
        <div key={method.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{method.name}</p>
            {method.description ? (
              <p className="text-xs text-muted-foreground">{method.description}</p>
            ) : null}
            {method.type === "env_var" ? (
              <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                <p>
                  Configure these variables in this instance’s Environment variables section above.
                  Keep credential values marked Sensitive, then start a new session.
                </p>
                {method.variables?.map((variable) => (
                  <p key={variable.name}>
                    <code>{variable.name}</code>
                    {variable.label ? ` — ${variable.label}` : ""}
                    {variable.optional ? " (optional)" : " (required)"}
                    {variable.secret ? " · Sensitive" : ""}
                  </p>
                ))}
              </div>
            ) : method.type === "terminal" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Complete this agent’s sign-in setup in a terminal on the host node, then start a new
                session.
              </p>
            ) : null}
          </div>
          {method.type !== "env_var" && method.type !== "terminal" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!allowed || busy}
              onClick={() => void run(method.id)}
            >
              Sign in
            </Button>
          ) : null}
        </div>
      ))}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!allowed ? (
        <p className="text-xs text-muted-foreground">
          {capability.reason ??
            "Node management access and a current connection are required to authenticate."}
        </p>
      ) : null}
    </div>
  );
}

export function AcpRegistryAuthentication(props: {
  readonly instanceId: ProviderInstanceId;
  readonly installationKey: string;
}) {
  const target = useSettingsTarget();
  return (
    <AcpRegistryAuthenticationContent
      key={`${target?.environmentId ?? "primary"}:${props.instanceId}:${props.installationKey}`}
      instanceId={props.instanceId}
    />
  );
}
