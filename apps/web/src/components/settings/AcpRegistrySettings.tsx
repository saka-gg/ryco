import { useEffect, useRef, useState } from "react";
import { type AcpRegistryAgent, WS_METHODS } from "@ryco/contracts";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import { useSettingsTarget } from "../../settingsTarget";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  localCommandConfig,
  readAcpAgentConfig,
  registryAgentConfig,
  type AcpAgentConfig,
} from "./acpAgentConfig.logic";
import { AcpLocalCommandSettings } from "./AcpLocalCommandSettings";

/**
 * An ACP agent instance's source: a pinned registry install or a local command. The source can
 * only change in the add dialog; once added, its sessions and sign-in belong to that agent. Edits
 * keep the config keys this editor does not own, such as the instance's custom models.
 */
export function AcpRegistrySettings({
  value,
  onChange,
  variant,
}: {
  readonly value: unknown;
  readonly onChange: (config: Record<string, unknown>) => void;
  /** `dialog` edits a new instance's local draft; `card` saves each change to the node. */
  readonly variant: "card" | "dialog";
}) {
  const config = readAcpAgentConfig(value);
  return (
    <div className="grid gap-3">
      {variant === "dialog" ? (
        <ToggleGroup
          aria-label="Agent source"
          value={[config.source]}
          variant="outline"
          size="sm"
          onValueChange={(values) => {
            const next = values[0];
            if (next === config.source) return;
            if (next === "local") onChange({ source: "local", command: "", args: [] });
            if (next === "registry") onChange({});
          }}
        >
          <Toggle value="registry" className="px-3 sm:px-3">
            Registry agent
          </Toggle>
          <Toggle value="local" className="px-3 sm:px-3">
            Local command
          </Toggle>
        </ToggleGroup>
      ) : null}
      {config.source === "local" ? (
        <AcpLocalCommandSettings
          config={config}
          commitOnChange={variant === "dialog"}
          onChange={(next) => onChange(localCommandConfig(value, next))}
        />
      ) : (
        // Mounted only for registry agents, so editing a local command never fetches the index.
        <AcpRegistryAgentPicker
          config={config}
          onSelect={(installation) => onChange(registryAgentConfig(value, installation))}
        />
      )}
    </div>
  );
}

function AcpRegistryAgentPicker({
  config,
  onSelect,
}: {
  readonly config: AcpAgentConfig;
  readonly onSelect: (installation: { readonly agentId: string; readonly version: string }) => void;
}) {
  const target = useSettingsTarget();
  const capability = useHostedRpcCapability(
    WS_METHODS.serverInstallAcpRegistry,
    target?.environmentId ?? null,
  );
  const server = target
    ? readEnvironmentApi(target.environmentId)?.server
    : ensureLocalApi().server;
  const canInstall =
    capability.allowed &&
    (!target || (target.connected && target.canManage !== false && target.canMutate !== false));
  const [query, setQuery] = useState({ text: "" });
  const [agents, setAgents] = useState<ReadonlyArray<AcpRegistryAgent>>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const selectedId = config.agentId;
  const selectedVersion = config.version;

  useEffect(() => {
    const current = ++generation.current;
    const timer = setTimeout(() => {
      setAgents([]);
      setError(null);
      setInstalling(null);
      setLoading(true);
      if (!server?.searchAcpRegistry) {
        setLoading(false);
        setError("Reconnect to this node to browse the ACP registry.");
        return;
      }
      void server
        .searchAcpRegistry({ query: query.text })
        .then((result) => {
          if (generation.current === current) setAgents(result.agents);
        })
        .catch((cause: unknown) => {
          if (generation.current === current)
            setError(cause instanceof Error ? cause.message : "Could not load the registry.");
        })
        .finally(() => {
          if (generation.current === current) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      generation.current = current + 1;
    };
  }, [server, query]);

  // A promise chain rather than try/finally, which the React Compiler cannot compile.
  const install = (agent: AcpRegistryAgent) => {
    if (!server?.installAcpRegistry || !canInstall || installing) return;
    const current = generation.current;
    setInstalling(agent.id);
    setError(null);
    void server
      .installAcpRegistry({ agentId: agent.id, version: agent.version })
      .then((installation) => {
        if (generation.current !== current) return;
        onSelect({ agentId: installation.agentId, version: installation.version });
        setAgents((existing) =>
          existing.map((item) =>
            item.id === agent.id && item.version === agent.version
              ? { ...item, installed: true }
              : item,
          ),
        );
      })
      .catch((cause: unknown) => {
        if (generation.current === current)
          setError(cause instanceof Error ? cause.message : "Installation failed.");
      })
      .finally(() => {
        if (generation.current === current) setInstalling(null);
      });
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">ACP Registry</p>
        <p className="text-xs text-muted-foreground">
          Install an agent on this node at the displayed version. Ryco verifies its checksum before
          installation. Agents run with this node’s permissions when used.
        </p>
        {selectedId && selectedVersion ? (
          <p className="text-xs">
            Selected:{" "}
            <code>
              {selectedId}@{selectedVersion}
            </code>
          </p>
        ) : null}
      </div>
      <Input
        aria-label="Search ACP registry"
        placeholder="Search agents"
        maxLength={200}
        value={query.text}
        disabled={installing !== null}
        onChange={(event) => setQuery({ text: event.target.value })}
      />
      {error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>{error}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={installing !== null}
            onClick={() => setQuery((current) => ({ ...current }))}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div className="max-h-64 space-y-2 overflow-y-auto" aria-busy={loading}>
        {loading ? (
          <p className="text-xs text-muted-foreground" role="status">
            Loading registry…
          </p>
        ) : agents.length === 0 && !error ? (
          <p className="text-xs text-muted-foreground">No matching agents.</p>
        ) : null}
        {agents.map((agent) => (
          <div
            key={`${agent.id}@${agent.version}`}
            className="space-y-2 rounded-md border border-border bg-background p-3"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
              <Badge variant="outline" size="sm">
                {agent.version}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{agent.description}</p>
            <p className="break-all text-[11px] text-muted-foreground">
              {agent.id}
              {agent.license ? ` · ${agent.license}` : ""}
            </p>
            {agent.unavailableReason ? (
              <p className="text-xs text-muted-foreground">{agent.unavailableReason}</p>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={
                !canInstall ||
                !agent.installable ||
                installing !== null ||
                (selectedId === agent.id && selectedVersion === agent.version)
              }
              onClick={() => install(agent)}
            >
              {installing === agent.id
                ? "Installing…"
                : selectedId === agent.id && selectedVersion === agent.version
                  ? "Selected"
                  : agent.installed
                    ? "Use installed version"
                    : `Install ${agent.version}`}
            </Button>
          </div>
        ))}
      </div>
      {!canInstall ? (
        <p className="text-xs text-muted-foreground">
          {hostedCapabilityCopy(capability, target?.nodeLabel) ??
            "Node management access and a current connection are required to install agents."}
        </p>
      ) : null}
    </div>
  );
}
