import {
  AGENT_CONTROL_CAPABILITIES,
  type AgentControlCapability,
  type AgentControlExternalClientKind,
  type AgentControlExternalIntegrationCreateInput,
  type AgentControlExternalIntegrationDetail,
  type AgentControlExternalProjectScope,
  ProjectId,
} from "@ryco/contracts";
import {
  applyExternalIntegrationList,
  applyExternalIntegrationPairing,
  emptyExternalIntegrationSettingsState,
  removeExternalIntegration,
} from "@ryco/client-runtime/state/settings";
import {
  CheckIcon,
  ClipboardIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettingsTarget } from "../../settingsTarget";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsBlock,
  SettingsEmpty,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { retryAgentControlStartup } from "./agentControlStartupRetry";

export const AGENT_CONTROL_CLIENT_LABELS: Record<AgentControlExternalClientKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  "generic-mcp": "Generic MCP",
};

const CAPABILITY_OPTIONS: ReadonlyArray<{
  readonly capability: AgentControlCapability;
  readonly label: string;
  readonly description: string;
}> = [
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalListProjects,
    label: "List allowed projects",
    description: "Discover only projects inside this integration's scope.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalCreateTask,
    label: "Request tasks",
    description: "Submit one task to Ryco's normal approval queue.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadTask,
    label: "Read own tasks",
    description: "Read or wait only for tasks created by this integration.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadAutomations,
    label: "Read automations",
    description: "Read bounded schedules and run outcomes inside the selected project scope.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
    label: "Request automations",
    description: "Propose schedule changes; each due run still requires separate approval.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadActivity,
    label: "Read activity",
    description: "Read bounded payload-free project and provider event summaries.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadDiagnostics,
    label: "Read diagnostics",
    description: "Read redacted count-only health summaries for allowed projects.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadThreads,
    label: "Read threads",
    description:
      "List, search, read, wait on, and inspect threads in allowed projects. Terminal output stays private.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadReviews,
    label: "Read reviews",
    description: "Read checkpoint diffs and review history for threads in allowed projects.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadFiles,
    label: "Read workspace files",
    description:
      "Read any text file in a thread's workspace or worktree, including local configuration.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalReadWorkspaces,
    label: "Read projects and workspaces",
    description: "Read project preferences, workspace paths, and Git status without changing them.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalControlThreads,
    label: "Request thread control",
    description:
      "Propose messages, interrupts, and thread updates in allowed projects; each request needs approval.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalManageWorkspaces,
    label: "Request workspace changes",
    description:
      "Propose archiving, restoring, or deleting workspaces in allowed projects; each request needs approval.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
    label: "Request shared checkout",
    description: "May request the local checkout; each request still needs approval.",
  },
  {
    capability: AGENT_CONTROL_CAPABILITIES.externalFullAccess,
    label: "Request full access",
    description: "May request a full-access runtime; each request still needs approval.",
  },
];

export interface AgentControlIntegrationForm {
  readonly displayName: string;
  readonly clientKind: AgentControlExternalClientKind;
  readonly scopeKind: "all" | "selected";
  readonly projectIds: string;
  readonly capabilities: ReadonlyArray<AgentControlCapability>;
  readonly expiresAt: string;
  readonly rateLimitPerMinute: string;
  readonly activeTaskLimit: string;
}

export const createAgentControlIntegrationForm = (): AgentControlIntegrationForm => ({
  displayName: "",
  clientKind: "codex",
  scopeKind: "all",
  projectIds: "",
  capabilities: [
    AGENT_CONTROL_CAPABILITIES.externalListProjects,
    AGENT_CONTROL_CAPABILITIES.externalCreateTask,
    AGENT_CONTROL_CAPABILITIES.externalReadTask,
  ],
  expiresAt: "",
  rateLimitPerMinute: "60",
  activeTaskLimit: "1",
});

function showFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    }),
  );
}

function toCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args.map((arg) => JSON.stringify(arg))].join(" ");
}

function formatDate(value: string | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

function statusFor(detail: AgentControlExternalIntegrationDetail): {
  readonly label: string;
  readonly variant: "success" | "warning" | "error" | "outline";
} {
  const integration = detail.integration;
  if (integration.revokedAt !== null) return { label: "Revoked", variant: "error" };
  if (integration.expiresAt !== null && Date.parse(integration.expiresAt) <= Date.now()) {
    return { label: "Expired", variant: "error" };
  }
  if (integration.pairingState === "paired") return { label: "Paired", variant: "success" };
  if (integration.pairingState === "pending") return { label: "Pairing", variant: "warning" };
  return { label: "Unpaired", variant: "outline" };
}

function formFromDetail(
  detail: AgentControlExternalIntegrationDetail,
): AgentControlIntegrationForm {
  const integration = detail.integration;
  return {
    displayName: integration.displayName,
    clientKind: integration.clientKind,
    scopeKind: integration.projectScope.kind,
    projectIds:
      integration.projectScope.kind === "selected"
        ? integration.projectScope.projectIds.join(", ")
        : "",
    capabilities: integration.capabilities,
    expiresAt:
      integration.expiresAt === null
        ? ""
        : new Date(integration.expiresAt).toISOString().slice(0, 16),
    rateLimitPerMinute: String(integration.rateLimitPerMinute),
    activeTaskLimit: String(integration.activeTaskLimit),
  };
}

export function parseAgentControlIntegrationForm(
  form: AgentControlIntegrationForm,
): AgentControlExternalIntegrationCreateInput {
  const projectIds = form.projectIds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ProjectId.make(value));
  const projectScope: AgentControlExternalProjectScope =
    form.scopeKind === "all" ? { kind: "all" } : { kind: "selected", projectIds };
  const rateLimitPerMinute = Number(form.rateLimitPerMinute);
  const activeTaskLimit = Number(form.activeTaskLimit);
  if (!form.displayName.trim()) throw new Error("A display name is required.");
  if (form.scopeKind === "selected" && projectIds.length === 0) {
    throw new Error("Enter at least one project ID for selected-project scope.");
  }
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
    throw new Error("Rate limit must be a positive whole number.");
  }
  if (!Number.isInteger(activeTaskLimit) || activeTaskLimit < 1) {
    throw new Error("Active-task limit must be a positive whole number.");
  }
  return {
    displayName: form.displayName.trim(),
    clientKind: form.clientKind,
    projectScope,
    capabilities: form.capabilities,
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    rateLimitPerMinute,
    activeTaskLimit,
  };
}

export function AgentControlIntegrationFormFields({
  form,
  onChange,
  clientLocked = false,
}: {
  readonly form: AgentControlIntegrationForm;
  readonly onChange: (next: AgentControlIntegrationForm) => void;
  readonly clientLocked?: boolean;
}) {
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Display name
          <Input
            value={form.displayName}
            placeholder="Local Codex"
            onChange={(event) => onChange({ ...form, displayName: event.target.value })}
          />
        </label>
        <div className="grid gap-1.5 text-xs font-medium text-foreground">
          Client
          <SettingsSelect<AgentControlExternalClientKind>
            ariaLabel="Client"
            width="full"
            value={form.clientKind}
            disabled={clientLocked}
            onValueChange={(clientKind) => onChange({ ...form, clientKind })}
            options={Object.entries(AGENT_CONTROL_CLIENT_LABELS).map(([value, label]) => ({
              value: value as AgentControlExternalClientKind,
              label,
            }))}
          />
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-medium text-foreground">Project scope</legend>
        <RadioGroup
          value={form.scopeKind}
          onValueChange={(value) =>
            onChange({ ...form, scopeKind: value === "selected" ? "selected" : "all" })
          }
          className="gap-3"
        >
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground">
            <Radio value="all" className="mt-0.5" />
            <span>
              All current and future projects
              <span className="block text-xs text-muted-foreground">
                The client can discover every project on this local Ryco instance.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground">
            <Radio value="selected" className="mt-0.5" />
            <span className="min-w-0 flex-1">
              Selected projects
              <Input
                className="mt-1.5"
                value={form.projectIds}
                disabled={form.scopeKind !== "selected"}
                placeholder="project-id-1, project-id-2"
                aria-label="Selected project IDs"
                onChange={(event) => onChange({ ...form, projectIds: event.target.value })}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Comma-separated stable project IDs. Unknown IDs remain inaccessible.
              </span>
            </span>
          </label>
        </RadioGroup>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-xs font-medium text-foreground">Capability grants</legend>
        {CAPABILITY_OPTIONS.map((option) => (
          <label
            key={option.capability}
            className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground"
          >
            <Checkbox
              className="mt-0.5"
              checked={form.capabilities.includes(option.capability)}
              onCheckedChange={(checked) =>
                onChange({
                  ...form,
                  capabilities:
                    checked === true
                      ? [...form.capabilities, option.capability]
                      : form.capabilities.filter((value) => value !== option.capability),
                })
              }
            />
            <span>
              {option.label}
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Expires
          <Input
            type="datetime-local"
            value={form.expiresAt}
            onChange={(event) => onChange({ ...form, expiresAt: event.target.value })}
          />
          <span className="font-normal text-muted-foreground">Empty means no expiry.</span>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Requests per minute
          <Input
            type="number"
            min={1}
            max={600}
            value={form.rateLimitPerMinute}
            onChange={(event) => onChange({ ...form, rateLimitPerMinute: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Concurrent active tasks
          <Input
            type="number"
            min={1}
            max={32}
            value={form.activeTaskLimit}
            onChange={(event) => onChange({ ...form, activeTaskLimit: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}

function CopyButton({
  copied,
  onClick,
  label,
  iconOnly = false,
}: {
  copied: boolean;
  onClick: () => void;
  label: string;
  iconOnly?: boolean;
}) {
  return (
    <Button
      size={iconOnly ? "icon-xs" : "xs"}
      variant="outline"
      aria-label={iconOnly ? label : undefined}
      onClick={onClick}
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
      {iconOnly ? null : label}
    </Button>
  );
}

export function ExternalIntegrationsSettings() {
  const settingsTarget = useSettingsTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsTarget?.environmentId ?? primaryEnvironmentId;
  const [state, setState] = useState(emptyExternalIntegrationSettingsState);
  const [form, setForm] = useState(createAgentControlIntegrationForm);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const api = useMemo(
    () => (environmentId === null ? undefined : readEnvironmentApi(environmentId)?.agentControl),
    [environmentId],
  );

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const result = await retryAgentControlStartup(() => api.listIntegrations());
      setState((current) => applyExternalIntegrationList(current, result));
    } catch (error) {
      showFailure("Failed to load external integrations", error);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = useCallback(async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1_500);
  }, []);

  const create = async () => {
    if (!api) return;
    try {
      setBusyId("new");
      const result = await api.createIntegration(parseAgentControlIntegrationForm(form));
      setState((current) => applyExternalIntegrationPairing(current, result));
      setForm(createAgentControlIntegrationForm());
      setCreating(false);
    } catch (error) {
      showFailure("Failed to create integration", error);
    } finally {
      setBusyId(null);
    }
  };

  const save = async (detail: AgentControlExternalIntegrationDetail) => {
    if (!api) return;
    try {
      setBusyId(detail.integration.integrationId);
      const values = parseAgentControlIntegrationForm(form);
      await api.updateIntegration({
        integrationId: detail.integration.integrationId,
        ...values,
      });
      setEditingId(null);
      await refresh();
    } catch (error) {
      showFailure("Failed to update integration", error);
    } finally {
      setBusyId(null);
    }
  };

  const resume = async (detail: AgentControlExternalIntegrationDetail) => {
    if (!api) return;
    const integrationId = detail.integration.integrationId;
    try {
      setBusyId(integrationId);
      const result = await api.resumeIntegrationPairing({ integrationId });
      setState((current) => applyExternalIntegrationPairing(current, result));
    } catch (error) {
      showFailure("Failed to resume pairing", error);
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (detail: AgentControlExternalIntegrationDetail) => {
    if (!api) return;
    const integrationId = detail.integration.integrationId;
    try {
      setBusyId(integrationId);
      await api.revokeIntegration({ integrationId });
      await refresh();
    } catch (error) {
      showFailure("Failed to revoke integration", error);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (detail: AgentControlExternalIntegrationDetail) => {
    if (!api) return;
    const integrationId = detail.integration.integrationId;
    if (!window.confirm(`Delete ${detail.integration.displayName}? This cannot be undone.`)) return;
    try {
      setBusyId(integrationId);
      const result = await api.deleteIntegration({ integrationId });
      if (result.deleted) setState((current) => removeExternalIntegration(current, integrationId));
    } catch (error) {
      showFailure("Failed to delete integration", error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsSection
      data-testid="external-integrations"
      title="External integrations"
      description="Pair a local MCP client with a revocable identity. Every task request waits in Ryco for explicit user approval before a thread is created."
      headerAction={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Refresh integrations"
                  onClick={() => void refresh()}
                >
                  <RefreshCwIcon />
                </Button>
              }
            />
            <TooltipPopup>Refresh</TooltipPopup>
          </Tooltip>
          <Button
            size="xs"
            disabled={!api || !state.topology.available}
            onClick={() => {
              setEditingId(null);
              setForm(createAgentControlIntegrationForm());
              setCreating((value) => !value);
            }}
          >
            <PlusIcon />
            New integration
          </Button>
        </>
      }
    >
      {!state.topology.available ? (
        <SettingsBlock>
          <SettingsNotice tone="warning" title="Local pairing is unavailable">
            {state.topology.reason ?? "Ryco could not prove a direct loopback-only topology."}{" "}
            External setup fails closed while Ryco is remotely exposed or Hub-connected.
          </SettingsNotice>
        </SettingsBlock>
      ) : null}

      {creating ? (
        <SettingsBlock className="settings-subsections-enter bg-muted/30">
          <AgentControlIntegrationFormFields form={form} onChange={setForm} />
          <div className="mt-5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busyId === "new"} onClick={() => void create()}>
              <KeyRoundIcon />
              Create and pair
            </Button>
          </div>
        </SettingsBlock>
      ) : null}

      {state.integrations.length === 0 && !creating ? (
        <SettingsEmpty
          icon={<KeyRoundIcon />}
          title="No external integrations"
          description="Create one to pair an MCP client Ryco can't detect on its own."
          className="py-8"
        />
      ) : null}

      {state.integrations.map((detail) => {
        const integration = detail.integration;
        const status = statusFor(detail);
        const pairingCode = state.pairingCodes[integration.integrationId];
        const pairCommand = toCommand(
          detail.setup.pairCommand.command,
          detail.setup.pairCommand.args,
        );
        const isEditing = editingId === integration.integrationId;
        return (
          <SettingsRow
            key={integration.integrationId}
            title={
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate">{integration.displayName}</span>
                <Badge size="sm" variant={status.variant}>
                  {status.label}
                </Badge>
                <Badge size="sm" variant="outline">
                  {AGENT_CONTROL_CLIENT_LABELS[integration.clientKind]}
                </Badge>
              </span>
            }
            description={
              <span className="break-all font-mono text-[11px]">{integration.integrationId}</span>
            }
            control={
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(isEditing ? null : integration.integrationId);
                    setForm(formFromDetail(detail));
                  }}
                >
                  {isEditing ? "Close editor" : "Edit"}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    !state.topology.available ||
                    busyId === integration.integrationId ||
                    integration.revokedAt !== null
                  }
                  onClick={() => void resume(detail)}
                >
                  <KeyRoundIcon />
                  Pair again
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyId === integration.integrationId || integration.revokedAt !== null}
                  onClick={() => void revoke(detail)}
                >
                  Revoke
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive-foreground"
                  aria-label={`Delete ${integration.displayName}`}
                  disabled={busyId === integration.integrationId}
                  onClick={() => void remove(detail)}
                >
                  <Trash2Icon />
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              {isEditing ? (
                <div className="settings-subsections-enter grid gap-5 rounded-[min(var(--radius-lg),0.625rem)] bg-muted/40 p-4">
                  <AgentControlIntegrationFormFields form={form} onChange={setForm} />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={busyId === integration.integrationId}
                      onClick={() => void save(detail)}
                    >
                      <SaveIcon />
                      Save changes
                    </Button>
                  </div>
                </div>
              ) : (
                <dl className="grid gap-x-6 gap-y-2.5 text-xs sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">Project scope</dt>
                    <dd className="mt-0.5 break-words text-foreground">
                      {integration.projectScope.kind === "all"
                        ? "All current and future projects"
                        : integration.projectScope.projectIds.join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Limits</dt>
                    <dd className="mt-0.5 text-foreground tabular-nums">
                      {integration.rateLimitPerMinute}/minute · {integration.activeTaskCount}/
                      {integration.activeTaskLimit} active
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Expiry</dt>
                    <dd className="mt-0.5 text-foreground">{formatDate(integration.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last used</dt>
                    <dd className="mt-0.5 text-foreground">{formatDate(integration.lastUsedAt)}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">Capabilities</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {integration.capabilities.map((capability) => (
                        <Badge key={capability} size="sm" variant="outline">
                          {capability}
                        </Badge>
                      ))}
                    </dd>
                  </div>
                </dl>
              )}

              {integration.pairingState === "pending" ? (
                <div className="grid min-w-0 gap-4 rounded-[min(var(--radius-lg),0.625rem)] bg-muted/40 p-4">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      Finish pairing locally
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Pairing code expires {formatDate(integration.pairingCodeExpiresAt)}. The code
                      is shown only for this ceremony; the generated MCP configuration never
                      contains it.
                    </p>
                  </div>
                  {pairingCode ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <code
                        data-testid="external-pairing-code"
                        className="rounded-[min(var(--radius-md),0.5rem)] bg-background px-3 py-1.5 font-mono text-sm tracking-[0.18em] text-foreground"
                      >
                        {pairingCode}
                      </code>
                      <CopyButton
                        label="Copy code"
                        copied={copied === `code-${integration.integrationId}`}
                        onClick={() => void copy(`code-${integration.integrationId}`, pairingCode)}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-warning-foreground">
                      The pairing code is no longer displayed. Choose Pair again to generate a new
                      one.
                    </p>
                  )}
                  <div className="grid min-w-0 gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      Run this bridge command, then enter the code
                    </span>
                    <div className="flex min-w-0 items-start gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-[min(var(--radius-md),0.5rem)] bg-background px-2.5 py-2 font-mono text-[11px] text-foreground">
                        {pairCommand}
                      </code>
                      <CopyButton
                        iconOnly
                        label="Copy pairing command"
                        copied={copied === `pair-${integration.integrationId}`}
                        onClick={() => void copy(`pair-${integration.integrationId}`, pairCommand)}
                      />
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground">MCP configuration</span>
                      <CopyButton
                        label="Copy configuration"
                        copied={copied === `config-${integration.integrationId}`}
                        onClick={() =>
                          void copy(
                            `config-${integration.integrationId}`,
                            detail.setup.configuration,
                          )
                        }
                      />
                    </div>
                    <pre
                      data-testid="external-mcp-configuration"
                      className="max-h-48 min-w-0 overflow-auto rounded-[min(var(--radius-md),0.5rem)] bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground"
                    >
                      {detail.setup.configuration}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
