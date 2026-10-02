import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Globe2Icon,
  LoaderIcon,
  LogInIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EnvironmentApi,
  McpServerName,
  McpWorkspaceId,
  type McpListServersResult,
  type McpListWorkspacesResult,
  type McpProviderCapabilities,
  type McpProviderSupport,
  type McpServer,
  type McpWorkspace,
} from "@ryco/contracts";

import { cn } from "../../lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import { useSettingsTarget } from "../../settingsTarget";
import {
  configFromMcpServerForm,
  createEmptyMcpServerForm,
  formFromMcpServer,
  secretMutationsFromMcpServerForm,
  summarizeMcpServerConnection,
  validateMcpServerForm,
  type McpServerFormState,
} from "../../mcpServers";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getDriverOption } from "./providerDriverMeta";
import {
  SETTINGS_INSET_CLASS,
  SettingsBlock,
  SettingsEmpty,
  SettingsNotice,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type McpApi = NonNullable<EnvironmentApi["mcp"]>;
const EMPTY_WORKSPACES: readonly McpWorkspace[] = [];
const EMPTY_PROVIDERS: readonly McpProviderSupport[] = [];

function requireMcpApi(api: McpApi | undefined): McpApi {
  if (!api) {
    throw new Error("MCP settings are unavailable before a backend is paired.");
  }
  return api;
}

function showErrorToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function sourceLabel(source: McpServer["source"]): string {
  switch (source) {
    case "user":
      return "User config";
    case "project":
      return "Project";
    case "system":
      return "System";
    case "managed":
      return "Managed";
    case "mixed":
      return "Mixed";
    case "unknown":
      return "Unknown";
  }
}

function statusVariant(server: McpServer): "success" | "warning" | "error" | "outline" {
  if (server.startupStatus === "failed") return "error";
  if (server.startupStatus === "disabled") return "outline";
  if (server.authStatus === "notLoggedIn") return "warning";
  if (server.startupStatus === "ready") return "success";
  return "outline";
}

function statusLabel(server: McpServer): string {
  if (server.startupStatus === "disabled") return "Disabled";
  if (server.startupStatus === "failed") return "Failed";
  if (server.authStatus === "notLoggedIn") return "Login needed";
  if (server.startupStatus === "ready") return "Ready";
  return "Unknown";
}

function providerSupportVariant(provider: McpProviderSupport): "success" | "warning" | "outline" {
  if (!provider.enabled) return "outline";
  if (provider.status === "managed") return "success";
  if (provider.status === "external") return "warning";
  return "outline";
}

function providerSupportLabel(provider: McpProviderSupport): string {
  if (!provider.enabled) return "Disabled";
  switch (provider.status) {
    case "managed":
      return "Managed";
    case "external":
      return "External config";
    case "unsupported":
      return "Not wired";
  }
}

function providerDisplayName(provider: McpProviderSupport): string {
  return (
    provider.displayName ??
    getDriverOption(provider.driver)?.label ??
    formatProviderDriverKindLabel(provider.driver)
  );
}

function workspaceProviderDisplayName(workspace: McpWorkspace | null): string {
  if (!workspace) return "the provider";
  return (
    workspace.providerDisplayName ??
    getDriverOption(workspace.driver)?.label ??
    formatProviderDriverKindLabel(workspace.driver)
  );
}

function FieldLabel(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground/80">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function TextareaHelp({ children }: { readonly children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-muted-foreground/70">{children}</p>;
}

function TransportToggle({
  value,
  onChange,
}: {
  readonly value: "stdio" | "http";
  readonly onChange: (value: "stdio" | "http") => void;
}) {
  return (
    <div className="grid grid-cols-2 rounded-[min(var(--radius-lg),0.625rem)] bg-muted/70 p-0.5">
      {[
        { value: "stdio" as const, label: "Stdio", icon: TerminalIcon },
        { value: "http" as const, label: "HTTP", icon: Globe2Icon },
      ].map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-7 items-center justify-center gap-2 rounded-[min(var(--radius-md),0.5rem)] text-xs font-medium transition-[background-color,color,box-shadow] duration-(--app-motion-duration-chip)",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function McpServerDialog({
  open,
  server,
  providerName,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly server: McpServer | null;
  readonly providerName: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (form: McpServerFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<McpServerFormState>(() => createEmptyMcpServerForm());
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = server !== null;

  useEffect(() => {
    if (!open) return;
    setForm(server ? formFromMcpServer(server) : createEmptyMcpServerForm());
    setValidationError(null);
  }, [open, server]);

  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    const error = validateMcpServerForm(form);
    if (error) {
      setValidationError(error);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(form);
      onOpenChange(false);
    } catch (cause) {
      showErrorToast("Failed to save MCP server", cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            Configuration is written through {providerName}&apos;s native MCP management surface.
            Existing secret values are never loaded into this form and are retained unless you enter
            replacements with the same keys.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <FieldLabel label="Server name">
              <Input
                value={form.name}
                disabled={editing}
                onChange={(event) => setField("name", event.target.value)}
                placeholder="github"
                spellCheck={false}
              />
            </FieldLabel>
            <FieldLabel label="Transport">
              <TransportToggle
                value={form.transport}
                onChange={(value) => setField("transport", value)}
              />
            </FieldLabel>
          </div>

          {form.transport === "stdio" ? (
            <div className="grid gap-4">
              <FieldLabel label="Command">
                <Input
                  value={form.command}
                  onChange={(event) => setField("command", event.target.value)}
                  placeholder="npx"
                  spellCheck={false}
                />
              </FieldLabel>
              <FieldLabel label="Arguments">
                <Textarea
                  value={form.argsText}
                  onChange={(event) => setField("argsText", event.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/tmp/project"}
                  spellCheck={false}
                />
                <TextareaHelp>One argument per line.</TextareaHelp>
              </FieldLabel>
              <FieldLabel label="Working directory">
                <Input
                  value={form.cwd}
                  onChange={(event) => setField("cwd", event.target.value)}
                  placeholder="/path/to/project"
                  spellCheck={false}
                />
              </FieldLabel>
            </div>
          ) : (
            <div className="grid gap-4">
              <FieldLabel label="URL">
                <Input
                  value={form.url}
                  onChange={(event) => setField("url", event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                />
              </FieldLabel>
              <FieldLabel label="Bearer token env var">
                <Input
                  value={form.bearerTokenEnvVar}
                  onChange={(event) => setField("bearerTokenEnvVar", event.target.value)}
                  placeholder="MCP_TOKEN"
                  spellCheck={false}
                />
              </FieldLabel>
              <FieldLabel label="HTTP headers">
                <Textarea
                  value={form.httpHeadersText}
                  onChange={(event) => setField("httpHeadersText", event.target.value)}
                  placeholder="X-Client=ryco"
                  spellCheck={false}
                />
                <TextareaHelp>Static headers as KEY=VALUE lines.</TextareaHelp>
              </FieldLabel>
              <FieldLabel label="Env-backed HTTP headers">
                <Textarea
                  value={form.envHttpHeadersText}
                  onChange={(event) => setField("envHttpHeadersText", event.target.value)}
                  placeholder="Authorization=GITHUB_TOKEN"
                  spellCheck={false}
                />
                <TextareaHelp>Header name to environment variable name, one per line.</TextareaHelp>
              </FieldLabel>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FieldLabel label="Environment values">
              <Textarea
                value={form.envText}
                onChange={(event) => setField("envText", event.target.value)}
                placeholder="API_BASE=https://example.com"
                spellCheck={false}
              />
              <TextareaHelp>KEY=VALUE lines stored by the selected provider.</TextareaHelp>
            </FieldLabel>
            <FieldLabel label="Environment allow-list">
              <Textarea
                value={form.envVarsText}
                onChange={(event) => setField("envVarsText", event.target.value)}
                placeholder={"GITHUB_TOKEN\nSENTRY_AUTH_TOKEN"}
                spellCheck={false}
              />
              <TextareaHelp>One env var name per line.</TextareaHelp>
            </FieldLabel>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FieldLabel label="Startup timeout seconds">
              <Input
                value={form.startupTimeoutSec}
                onChange={(event) => setField("startupTimeoutSec", event.target.value)}
                inputMode="decimal"
                placeholder="10"
              />
            </FieldLabel>
            <FieldLabel label="Tool timeout seconds">
              <Input
                value={form.toolTimeoutSec}
                onChange={(event) => setField("toolTimeoutSec", event.target.value)}
                inputMode="decimal"
                placeholder="60"
              />
            </FieldLabel>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FieldLabel label="Enabled tools">
              <Textarea
                value={form.enabledToolsText}
                onChange={(event) => setField("enabledToolsText", event.target.value)}
                spellCheck={false}
              />
            </FieldLabel>
            <FieldLabel label="Disabled tools">
              <Textarea
                value={form.disabledToolsText}
                onChange={(event) => setField("disabledToolsText", event.target.value)}
                spellCheck={false}
              />
            </FieldLabel>
            <FieldLabel label="OAuth scopes">
              <Textarea
                value={form.oauthScopesText}
                onChange={(event) => setField("oauthScopesText", event.target.value)}
                spellCheck={false}
              />
            </FieldLabel>
          </div>

          <div className="flex flex-wrap items-center gap-5 border-t pt-4">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground/80">
              <Switch
                checked={form.enabled}
                onCheckedChange={(value) => setField("enabled", Boolean(value))}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-foreground/80">
              <Switch
                checked={form.required}
                onCheckedChange={(value) => setField("required", Boolean(value))}
              />
              Required
            </label>
          </div>

          {form.secretFields.length > 0 ? (
            <fieldset className="grid gap-2 border-t pt-4">
              <legend className="text-xs font-medium">Stored secret fields</legend>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                Values remain inside the provider configuration and are never loaded by this page.
                Select a field only when you want it removed on save.
              </p>
              {form.secretFields.map((field) => (
                <div key={field} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    aria-label={`Clear ${field}`}
                    checked={form.clearedSecretFields.includes(field)}
                    onCheckedChange={(checked) =>
                      setField(
                        "clearedSecretFields",
                        checked === true
                          ? [...form.clearedSecretFields, field]
                          : form.clearedSecretFields.filter((entry) => entry !== field),
                      )
                    }
                  />
                  <span aria-hidden>
                    Clear <code className="font-mono">{field}</code>
                  </span>
                </div>
              ))}
            </fieldset>
          ) : null}

          {validationError ? <SettingsNotice tone="error">{validationError}</SettingsNotice> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <LoaderIcon className="animate-spin" /> : <SaveIcon />}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function workspaceOptionLabel(workspace: McpWorkspace): string {
  return `${workspaceProviderDisplayName(workspace)} · ${workspace.nativeScope} scope`;
}

function WorkspaceSelect({
  workspaces,
  selectedWorkspaceId,
  onChange,
}: {
  readonly workspaces: readonly McpWorkspace[];
  readonly selectedWorkspaceId: string | null;
  readonly onChange: (workspaceId: string) => void;
}) {
  if (workspaces.length <= 1 || !selectedWorkspaceId) return null;
  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);

  return (
    <Select
      value={selectedWorkspaceId}
      onValueChange={(workspaceId) => {
        if (workspaceId) onChange(workspaceId);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="MCP workspace">
        <SelectValue>{selected ? workspaceOptionLabel(selected) : "Select workspace"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {workspaces.map((workspace) => (
          <SelectItem hideIndicator key={workspace.id} value={workspace.id}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{workspaceOptionLabel(workspace)}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {workspace.displayPath}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ProviderSupportSection({
  providers,
  selectedWorkspaceId,
  onSelectWorkspace,
}: {
  readonly providers: readonly McpProviderSupport[];
  readonly selectedWorkspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string) => void;
}) {
  if (providers.length === 0) return null;

  return (
    <SettingsSection
      title="Provider support"
      description="Each agent manages MCP servers in its own configuration. Pick one to view its servers."
    >
      {providers.map((provider) => {
        const driverOption = getDriverOption(provider.driver);
        const Icon = driverOption?.icon ?? ServerIcon;
        const workspaceSelected =
          provider.workspaceId !== undefined && provider.workspaceId === selectedWorkspaceId;
        const canSelectWorkspace = provider.workspaceId !== undefined && !workspaceSelected;

        return (
          <SettingsRow
            key={provider.instanceId}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="relative flex size-5 shrink-0 items-center justify-center">
                  <Icon className="size-4 text-muted-foreground" />
                  {provider.accentColor ? (
                    <span
                      className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card"
                      style={{ backgroundColor: provider.accentColor }}
                    />
                  ) : null}
                </span>
                <span className="truncate">{providerDisplayName(provider)}</span>
                <span className="truncate font-mono text-[11px] font-normal text-muted-foreground/70">
                  {provider.instanceId}
                </span>
              </span>
            }
            description={provider.message}
            control={
              <>
                <Badge size="sm" variant={providerSupportVariant(provider)}>
                  {providerSupportLabel(provider)}
                </Badge>
                {provider.workspaceId ? (
                  <Button
                    size="xs"
                    variant={workspaceSelected ? "secondary" : "outline"}
                    disabled={!canSelectWorkspace}
                    onClick={() => {
                      if (provider.workspaceId) onSelectWorkspace(provider.workspaceId);
                    }}
                  >
                    {workspaceSelected ? "Showing" : "Show servers"}
                  </Button>
                ) : null}
              </>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

function InventoryColumn({
  title,
  items,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly detail?: string | undefined;
  }>;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-xs font-medium text-foreground">
        {title} <span className="font-normal text-muted-foreground">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">None</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.key} className="min-w-0">
              <p className="truncate text-xs text-foreground">{item.name}</p>
              {item.detail ? (
                <p className="line-clamp-2 text-[11px] text-muted-foreground">{item.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InventoryList({ server }: { readonly server: McpServer }) {
  if (
    server.tools.length === 0 &&
    server.resources.length === 0 &&
    server.resourceTemplates.length === 0
  ) {
    return <p className="text-xs text-muted-foreground/70">No tools or resources reported.</p>;
  }

  return (
    <div className="grid gap-5 md:grid-cols-3">
      <InventoryColumn
        title="Tools"
        items={server.tools.slice(0, 12).map((tool) => ({
          key: tool.name,
          name: tool.title ?? tool.name,
          detail: tool.description ?? undefined,
        }))}
      />
      <InventoryColumn
        title="Resources"
        items={server.resources.slice(0, 10).map((resource) => ({
          key: resource.uri,
          name: resource.title ?? resource.name,
          detail: resource.uri,
        }))}
      />
      <InventoryColumn
        title="Templates"
        items={server.resourceTemplates.slice(0, 10).map((template) => ({
          key: template.uriTemplate,
          name: template.title ?? template.name,
          detail: template.uriTemplate,
        }))}
      />
    </div>
  );
}

const AUTH_STATUS_LABELS: Record<McpServer["authStatus"], string | null> = {
  unsupported: null,
  notLoggedIn: "Signed out",
  bearerToken: "Bearer token",
  oAuth: "OAuth",
  unknown: null,
};

function McpServerCard({
  server,
  capabilities,
  writable,
  mutating,
  onToggleEnabled,
  onEdit,
  onRemove,
  onOauthLogin,
}: {
  readonly server: McpServer;
  readonly capabilities: McpProviderCapabilities;
  readonly writable: boolean;
  readonly mutating: boolean;
  readonly onToggleEnabled: (server: McpServer, enabled: boolean) => void;
  readonly onEdit: (server: McpServer) => void;
  readonly onRemove: (server: McpServer) => void;
  readonly onOauthLogin: (server: McpServer) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const connection = summarizeMcpServerConnection(server);
  const inventoryAvailable = capabilities.inventory === "available";
  const inventoryLabel = inventoryAvailable
    ? `${server.tools.length} tools · ${server.resources.length + server.resourceTemplates.length} resources`
    : "Inventory not available";

  const authLabel = AUTH_STATUS_LABELS[server.authStatus];
  const meta = [server.config.transport.toUpperCase(), inventoryLabel, authLabel].filter(Boolean);

  return (
    <div className={cn("min-w-0 border-t border-border/60 first:border-t-0")}>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-3 py-3.5 sm:flex-row sm:items-center",
          SETTINGS_INSET_CLASS,
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {server.config.transport === "http" ? (
              <Globe2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {server.name}
            </h3>
            <Badge size="sm" variant={statusVariant(server)}>
              {statusLabel(server)}
            </Badge>
            <Badge size="sm" variant="outline">
              {sourceLabel(server.source)}
            </Badge>
          </div>
          <p
            className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
            title={connection}
          >
            {connection}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">{meta.join(" · ")}</p>
          {server.error ? (
            <p className="mt-1.5 break-words text-xs text-destructive-foreground">{server.error}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {capabilities.oauth === "available" && server.authStatus === "notLoggedIn" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={mutating}
              onClick={() => onOauthLogin(server)}
              aria-label={`Log in to ${server.name}`}
            >
              <LogInIcon />
              Log in
            </Button>
          ) : null}
          {writable && capabilities.upsert === "available" ? (
            <Button size="xs" variant="outline" onClick={() => onEdit(server)} disabled={mutating}>
              Edit
            </Button>
          ) : null}
          {writable && capabilities.remove === "available" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive-foreground"
                    disabled={mutating}
                    onClick={() => onRemove(server)}
                    aria-label={`Remove ${server.name}`}
                  >
                    <Trash2Icon />
                  </Button>
                }
              />
              <TooltipPopup>Remove server</TooltipPopup>
            </Tooltip>
          ) : null}
          {writable && capabilities.enableDisable === "available" ? (
            <Switch
              checked={server.config.enabled}
              disabled={mutating}
              onCheckedChange={(checked) => onToggleEnabled(server, Boolean(checked))}
              aria-label={`Enable ${server.name}`}
            />
          ) : null}
          {inventoryAvailable ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              aria-label={`Toggle ${server.name} inventory`}
            >
              <ChevronDownIcon
                className={cn(
                  "transition-transform duration-(--app-motion-duration-chip)",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          ) : null}
        </div>
      </div>

      {expanded && inventoryAvailable ? (
        <div
          className={cn(
            "settings-subsections-enter border-t border-border/60 bg-muted/30 py-3.5",
            SETTINGS_INSET_CLASS,
          )}
        >
          <InventoryList server={server} />
        </div>
      ) : null}
    </div>
  );
}

export function McpServersSettings() {
  const settingsTarget = useSettingsTarget();
  const mcpApi = useMemo(
    () =>
      settingsTarget ? readEnvironmentApi(settingsTarget.environmentId)?.mcp : ensureLocalApi().mcp,
    [settingsTarget],
  );
  const [workspacesResult, setWorkspacesResult] = useState<McpListWorkspacesResult | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<McpListServersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutatingName, setMutatingName] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaces = workspacesResult?.workspaces ?? EMPTY_WORKSPACES;
  const providers = workspacesResult?.providers ?? EMPTY_PROVIDERS;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedCapabilities = selectedWorkspace?.capabilities;
  const selectedProviderName = workspaceProviderDisplayName(selectedWorkspace);

  const loadServers = useCallback(
    async (workspaceId: string, options?: { quiet?: boolean }) => {
      if (!options?.quiet) setRefreshing(true);
      setError(null);
      try {
        const result = await requireMcpApi(mcpApi).listServers({
          workspaceId: McpWorkspaceId.make(workspaceId),
          detail: "full",
        });
        setSnapshot(result);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load MCP servers.");
        showErrorToast("Failed to load MCP servers", cause);
      } finally {
        setRefreshing(false);
      }
    },
    [mcpApi],
  );

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await requireMcpApi(mcpApi).listWorkspaces();
      setWorkspacesResult(result);
      const nextSelected =
        result.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.id ??
        result.workspaces[0]?.id ??
        null;
      setSelectedWorkspaceId(nextSelected);
      if (nextSelected) {
        await loadServers(nextSelected, { quiet: true });
      } else {
        setSnapshot(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load MCP workspaces.");
      showErrorToast("Failed to load MCP workspaces", cause);
    } finally {
      setLoading(false);
    }
  }, [loadServers, mcpApi, selectedWorkspaceId]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const refresh = async () => {
    if (!selectedWorkspaceId) {
      await loadWorkspaces();
      return;
    }
    await loadServers(selectedWorkspaceId);
  };

  const reload = async () => {
    if (!selectedWorkspaceId) return;
    setRefreshing(true);
    try {
      const result = await requireMcpApi(mcpApi).reloadServers({
        workspaceId: McpWorkspaceId.make(selectedWorkspaceId),
      });
      setSnapshot(result);
      toastManager.add(stackedThreadToast({ type: "success", title: "MCP servers reloaded" }));
    } catch (cause) {
      showErrorToast("Failed to reload MCP servers", cause);
    } finally {
      setRefreshing(false);
    }
  };

  const submitForm = async (form: McpServerFormState) => {
    if (!selectedWorkspaceId) return;
    const result = await requireMcpApi(mcpApi).upsertServer({
      workspaceId: McpWorkspaceId.make(selectedWorkspaceId),
      name: McpServerName.make(form.name.trim()),
      config: configFromMcpServerForm(form),
      secretMutations: secretMutationsFromMcpServerForm(form),
    });
    setSnapshot(result);
    toastManager.add(stackedThreadToast({ type: "success", title: "MCP server saved" }));
  };

  const toggleEnabled = async (server: McpServer, enabled: boolean) => {
    if (!selectedWorkspaceId) return;
    setMutatingName(server.name);
    try {
      const result = await requireMcpApi(mcpApi).setServerEnabled({
        workspaceId: McpWorkspaceId.make(selectedWorkspaceId),
        name: server.name,
        enabled,
      });
      setSnapshot(result);
    } catch (cause) {
      showErrorToast("Failed to update MCP server", cause);
    } finally {
      setMutatingName(null);
    }
  };

  const removeServer = async (server: McpServer) => {
    if (!selectedWorkspaceId) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(`Remove MCP server "${server.name}"?`);
    if (!confirmed) return;
    setMutatingName(server.name);
    try {
      const result = await requireMcpApi(mcpApi).removeServer({
        workspaceId: McpWorkspaceId.make(selectedWorkspaceId),
        name: server.name,
      });
      setSnapshot(result);
      toastManager.add(stackedThreadToast({ type: "success", title: "MCP server removed" }));
    } catch (cause) {
      showErrorToast("Failed to remove MCP server", cause);
    } finally {
      setMutatingName(null);
    }
  };

  const startOauthLogin = async (server: McpServer) => {
    if (!selectedWorkspaceId) return;
    setMutatingName(server.name);
    try {
      const result = await requireMcpApi(mcpApi).startOauthLogin({
        workspaceId: McpWorkspaceId.make(selectedWorkspaceId),
        serverName: server.name,
        scopes: server.config.oauthScopes,
      });
      await ensureLocalApi().shell.openExternal(result.authorizationUrl);
      toastManager.add(stackedThreadToast({ type: "success", title: "OAuth login opened" }));
    } catch (cause) {
      showErrorToast("Failed to start OAuth login", cause);
    } finally {
      setMutatingName(null);
    }
  };

  const openAddDialog = () => {
    setEditingServer(null);
    setDialogOpen(true);
  };

  const openEditDialog = (server: McpServer) => {
    setEditingServer(server);
    setDialogOpen(true);
  };

  const limits = selectedWorkspace
    ? [
        selectedWorkspace.capabilities.health !== "available"
          ? `${selectedProviderName} doesn't report live health`
          : null,
        selectedWorkspace.capabilities.inventory !== "available"
          ? "tool inventory unavailable"
          : null,
        selectedWorkspace.capabilities.enableDisable !== "available"
          ? "no per-server toggle"
          : null,
      ].filter((entry): entry is string => entry !== null)
    : [];

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Servers"
        description={
          selectedWorkspace
            ? `Read from ${selectedProviderName}'s own configuration. Controls appear only where it exposes a reliable operation.`
            : "Read from each agent's own configuration."
        }
        headerAction={
          <>
            <WorkspaceSelect
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onChange={(workspaceId) => {
                setSelectedWorkspaceId(workspaceId);
                void loadServers(workspaceId);
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => void refresh()}
                    disabled={loading || refreshing}
                    aria-label="Refresh MCP servers"
                  >
                    <RefreshCwIcon className={cn((loading || refreshing) && "animate-spin")} />
                  </Button>
                }
              />
              <TooltipPopup>Refresh</TooltipPopup>
            </Tooltip>
            {selectedCapabilities?.reload === "available" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!selectedWorkspaceId || refreshing}
                onClick={() => void reload()}
              >
                <WrenchIcon />
                Reload
              </Button>
            ) : null}
            {selectedCapabilities?.upsert === "available" ? (
              <Button size="xs" disabled={!selectedWorkspaceId} onClick={openAddDialog}>
                <PlusIcon />
                Add server
              </Button>
            ) : null}
          </>
        }
      >
        {selectedWorkspace ? (
          <SettingsBlock className="bg-muted/30 py-3">
            <p
              className="truncate font-mono text-[11px] text-foreground"
              title={snapshot?.configPath ?? selectedWorkspace.displayPath}
            >
              {snapshot?.configPath ?? selectedWorkspace.displayPath}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {[
                `${selectedWorkspace.nativeScope} scope`,
                `used by ${selectedWorkspace.providerInstances
                  .map((instance) => instance.displayName ?? instance.instanceId)
                  .join(", ")}`,
                ...limits,
              ].join(" · ")}
            </p>
          </SettingsBlock>
        ) : null}

        {workspacesResult?.issues.length || error ? (
          <SettingsBlock className="flex flex-col gap-2">
            {workspacesResult?.issues.map((issue) => (
              <SettingsNotice key={`${issue.instanceId}:${issue.message}`} tone="warning">
                <span className="font-medium text-foreground">{issue.instanceId}</span>:{" "}
                {issue.message}
              </SettingsNotice>
            ))}
            {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
          </SettingsBlock>
        ) : null}

        {loading ? (
          <SettingsBlock className="flex min-h-40 items-center justify-center">
            <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
          </SettingsBlock>
        ) : workspaces.length === 0 ? (
          <SettingsEmpty
            icon={<ServerIcon />}
            title="No MCP provider profiles"
            description="Add or enable a provider instance with a supported MCP configuration surface."
          />
        ) : snapshot?.servers.length === 0 ? (
          <SettingsEmpty
            icon={<CheckCircle2Icon />}
            title="No MCP servers configured"
            description={`Add a stdio or HTTP server to make its tools available to ${selectedProviderName} sessions.`}
            action={
              selectedCapabilities?.upsert === "available" ? (
                <Button size="sm" onClick={openAddDialog}>
                  <PlusIcon />
                  Add server
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="min-w-0 border-t border-border/60 first:border-t-0">
            {snapshot?.servers.map((server) => (
              <McpServerCard
                key={server.name}
                server={server}
                capabilities={
                  selectedCapabilities ?? {
                    readConfiguration: "unavailable",
                    upsert: "unavailable",
                    remove: "unavailable",
                    enableDisable: "unavailable",
                    reload: "unavailable",
                    health: "unavailable",
                    inventory: "unavailable",
                    oauth: "unavailable",
                    externalAgentControl: "unavailable",
                    automaticAgentControl: "unavailable",
                    scopes: [],
                  }
                }
                writable={
                  server.source === "user" ||
                  (server.source === "project" && selectedWorkspace?.nativeScope === "project")
                }
                mutating={mutatingName === server.name}
                onToggleEnabled={(target, enabled) => void toggleEnabled(target, enabled)}
                onEdit={openEditDialog}
                onRemove={(target) => void removeServer(target)}
                onOauthLogin={(target) => void startOauthLogin(target)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <ProviderSupportSection
        providers={providers}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={(workspaceId) => {
          setSelectedWorkspaceId(workspaceId);
          void loadServers(workspaceId);
        }}
      />

      <McpServerDialog
        open={dialogOpen}
        server={editingServer}
        providerName={selectedProviderName}
        onOpenChange={setDialogOpen}
        onSubmit={submitForm}
      />
    </SettingsPageContainer>
  );
}
