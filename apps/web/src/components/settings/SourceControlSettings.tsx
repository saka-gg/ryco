import { SourceControlPreferences } from "./SourceControlPreferences";
import { KeyRoundIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Option } from "effect";
import { type FormEvent, type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "~/rpc/queryClient";
import { invalidateAtlassian, useAtlassianConnections } from "~/rpc/useAtlassian";
import type {
  AtlassianConnectionSummary,
  EnvironmentId,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@ryco/contracts";

import { cn } from "../../lib/utils";
import {
  refreshSourceControlDiscovery,
  useSourceControlDiscovery,
} from "../../lib/sourceControlDiscoveryState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AtlassianJiraIcon,
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  SettingsBlock,
  SettingsEmpty,
  SettingsField,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readEnvironmentConnection } from "~/environments/runtime";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  forgejo: ForgejoIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const atlassianConnectionQueryKey = ["atlassian", "connections"] as const;

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
  authHost,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
  readonly authHost: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server — {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
          {authHost ? (
            <>
              <span aria-hidden>on</span>
              <code className="rounded bg-muted px-1 py-px text-[11px] text-muted-foreground">
                {authHost}
              </code>
            </>
          ) : null}
        </>
      );
    }

    if (!item.executable) {
      return <span>{item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-[11px]">{item.executable}</code>{" "}
          tool on the server host to enable pull request features.
        </span>
      );
    }
    return (
      <span>
        Could not verify {item.label}. {optionLabel(auth.detail) ?? item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const version = optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const authHost = auth ? optionLabel(auth.host) : null;

  const readiness = discoveryReadiness(item);

  return (
    <SettingsRow
      className={cn(isVcsNotReady(item) && "opacity-80")}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <SourceControlItemMark item={item} />
          <span className="truncate">{item.label}</span>
        </span>
      }
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-1">
          {itemSummary({ item, auth, authAccount, authHost })}
        </span>
      }
      control={
        <>
          {version ? (
            <code className="font-mono text-[11px] text-muted-foreground">{version}</code>
          ) : null}
          <Badge
            size="sm"
            variant={readiness.variant}
            aria-label={`${item.label} ${readiness.label}`}
          >
            {readiness.label}
          </Badge>
        </>
      }
    />
  );
}

function discoveryReadiness(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): {
  readonly label: string;
  readonly variant: "success" | "warning" | "outline";
} {
  if (isVcsNotReady(item)) return { label: "Coming soon", variant: "outline" };
  if (item.status !== "available") return { label: "Not installed", variant: "outline" };
  if (isProviderDiscoveryItem(item)) {
    if (item.auth.status === "unauthenticated")
      return { label: "Not signed in", variant: "warning" };
    if (item.auth.status !== "authenticated") return { label: "Unverified", variant: "outline" };
  }
  return { label: "Ready", variant: "success" };
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5 rounded-md" />
                  <Skeleton
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background"
                    aria-hidden
                  />
                </span>
                <Skeleton className="h-4 w-28 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full max-w-xs rounded-full" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function statusBadgeVariant(
  status: AtlassianConnectionSummary["status"],
): "success" | "warning" | "error" | "outline" {
  switch (status) {
    case "connected":
      return "success";
    case "needs_reauth":
      return "warning";
    case "invalid":
      return "error";
    case "revoked":
      return "outline";
  }
}

function formatConnectionKind(kind: AtlassianConnectionSummary["kind"]): string {
  switch (kind) {
    case "oauth_3lo":
      return "OAuth";
    case "bitbucket_token":
      return "Bitbucket token";
    case "jira_token":
      return "Jira token";
    case "env_fallback":
      return "Environment";
  }
}

function AtlassianProductIcon(props: {
  readonly products: AtlassianConnectionSummary["products"];
  readonly className?: string;
}) {
  if (props.products.includes("bitbucket")) {
    return <BitbucketIcon className={props.className} aria-hidden />;
  }
  return <AtlassianJiraIcon className={props.className} aria-hidden />;
}

function AtlassianConfiguration({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const queryClient = useQueryClient();
  const [bitbucketLabel, setBitbucketLabel] = useState("Bitbucket");
  const [bitbucketEmail, setBitbucketEmail] = useState("");
  const [bitbucketToken, setBitbucketToken] = useState("");
  const [jiraLabel, setJiraLabel] = useState("Jira");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraSiteUrl, setJiraSiteUrl] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [adding, setAdding] = useState<"bitbucket" | "jira" | null>(null);

  const connection = environmentId ? readEnvironmentConnection(environmentId) : null;
  const client = connection?.client ?? null;
  const connectionsQuery = useAtlassianConnections({
    environmentId,
    enabled: client !== null,
  });

  const saveTokenMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("No server connection is available.");
      return client.atlassian.saveManualBitbucketToken({
        label: bitbucketLabel.trim(),
        email: bitbucketEmail.trim(),
        token: bitbucketToken.trim(),
        isDefault: true,
      });
    },
    onSuccess: () => {
      setBitbucketLabel("Bitbucket");
      setBitbucketEmail("");
      setBitbucketToken("");
      setAdding(null);
      invalidateAtlassian({ environmentId });
      void queryClient.invalidateQueries({
        queryKey: atlassianConnectionQueryKey,
      });
      void refreshSourceControlDiscovery({ environmentId });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Bitbucket token saved",
          description: "Ryco can now use this Atlassian connection for Bitbucket workflows.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save Bitbucket token",
          description: error instanceof Error ? error.message : "The token could not be saved.",
        }),
      );
    },
  });

  const saveJiraTokenMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("No server connection is available.");
      return client.atlassian.saveManualJiraToken({
        label: jiraLabel.trim(),
        email: jiraEmail.trim(),
        siteUrl: jiraSiteUrl.trim(),
        token: jiraToken.trim(),
        isDefault: true,
      });
    },
    onSuccess: () => {
      setJiraLabel("Jira");
      setJiraEmail("");
      setJiraSiteUrl("");
      setJiraToken("");
      setAdding(null);
      invalidateAtlassian({ environmentId });
      void queryClient.invalidateQueries({
        queryKey: atlassianConnectionQueryKey,
      });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Jira token saved",
          description: "Ryco can now load Jira work items for linked projects.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save Jira token",
          description: error instanceof Error ? error.message : "The token could not be saved.",
        }),
      );
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (item: AtlassianConnectionSummary) => {
      if (!client) throw new Error("No server connection is available.");
      return client.atlassian.disconnect({ connectionId: item.connectionId });
    },
    onSuccess: () => {
      invalidateAtlassian({ environmentId });
      void queryClient.invalidateQueries({
        queryKey: atlassianConnectionQueryKey,
      });
      void refreshSourceControlDiscovery({ environmentId });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete Atlassian connection",
          description: error instanceof Error ? error.message : "The connection was not changed.",
        }),
      );
    },
  });

  const canSubmit =
    client !== null &&
    bitbucketLabel.trim().length > 0 &&
    bitbucketEmail.trim().length > 0 &&
    bitbucketToken.trim().length > 0 &&
    !saveTokenMutation.isPending;

  const canSubmitJira =
    client !== null &&
    jiraLabel.trim().length > 0 &&
    jiraEmail.trim().length > 0 &&
    jiraSiteUrl.trim().length > 0 &&
    jiraToken.trim().length > 0 &&
    !saveJiraTokenMutation.isPending;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    saveTokenMutation.mutate();
  };

  const handleJiraSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitJira) return;
    saveJiraTokenMutation.mutate();
  };

  const items = connectionsQuery.data ?? [];
  const connectionsPending = connectionsQuery.data === null && !connectionsQuery.isError;

  return (
    <SettingsSection
      title="Atlassian"
      description="Bitbucket and Jira connections for pull requests, diffs, and work-item links. Tokens stay in this device's secret store."
      headerAction={
        <>
          <Button
            size="xs"
            variant={adding === "bitbucket" ? "secondary" : "outline"}
            aria-expanded={adding === "bitbucket"}
            onClick={() => setAdding((current) => (current === "bitbucket" ? null : "bitbucket"))}
          >
            <BitbucketIcon className="size-3.5" aria-hidden />
            Add Bitbucket
          </Button>
          <Button
            size="xs"
            variant={adding === "jira" ? "secondary" : "outline"}
            aria-expanded={adding === "jira"}
            onClick={() => setAdding((current) => (current === "jira" ? null : "jira"))}
          >
            <AtlassianJiraIcon className="size-3.5" aria-hidden />
            Add Jira
          </Button>
        </>
      }
    >
      {adding === "bitbucket" ? (
        <SettingsBlock className="settings-subsections-enter bg-muted/30">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit}>
            <SettingsField label="Label" htmlFor="bitbucket-token-label">
              <Input
                id="bitbucket-token-label"
                size="sm"
                value={bitbucketLabel}
                autoComplete="organization"
                onChange={(event) => setBitbucketLabel(event.currentTarget.value)}
                placeholder="Bitbucket"
              />
            </SettingsField>
            <SettingsField label="Email" htmlFor="bitbucket-token-email">
              <Input
                id="bitbucket-token-email"
                size="sm"
                type="email"
                value={bitbucketEmail}
                autoComplete="username"
                onChange={(event) => setBitbucketEmail(event.currentTarget.value)}
                placeholder="you@example.com"
              />
            </SettingsField>
            <SettingsField
              label="App password"
              htmlFor="bitbucket-token-secret"
              className="sm:col-span-2"
              description="Stored in this device's server secret store, never in the browser."
            >
              <Input
                id="bitbucket-token-secret"
                size="sm"
                type="password"
                value={bitbucketToken}
                autoComplete="current-password"
                onChange={(event) => setBitbucketToken(event.currentTarget.value)}
                placeholder="Bitbucket app password"
              />
            </SettingsField>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {saveTokenMutation.isPending ? <Spinner className="size-3" /> : null}
                Save token
              </Button>
            </div>
          </form>
        </SettingsBlock>
      ) : null}

      {adding === "jira" ? (
        <SettingsBlock className="settings-subsections-enter bg-muted/30">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleJiraSubmit}>
            <SettingsField label="Label" htmlFor="jira-token-label">
              <Input
                id="jira-token-label"
                size="sm"
                value={jiraLabel}
                autoComplete="organization"
                onChange={(event) => setJiraLabel(event.currentTarget.value)}
                placeholder="Jira"
              />
            </SettingsField>
            <SettingsField label="Email" htmlFor="jira-token-email">
              <Input
                id="jira-token-email"
                size="sm"
                type="email"
                value={jiraEmail}
                autoComplete="username"
                onChange={(event) => setJiraEmail(event.currentTarget.value)}
                placeholder="you@example.com"
              />
            </SettingsField>
            <SettingsField label="Site URL" htmlFor="jira-site-url" className="sm:col-span-2">
              <Input
                id="jira-site-url"
                size="sm"
                value={jiraSiteUrl}
                inputMode="url"
                autoComplete="url"
                onChange={(event) => setJiraSiteUrl(event.currentTarget.value)}
                placeholder="https://your-team.atlassian.net"
              />
            </SettingsField>
            <SettingsField
              label="API token"
              htmlFor="jira-token-secret"
              className="sm:col-span-2"
              description="Stored in this device's server secret store, never in the browser."
            >
              <Input
                id="jira-token-secret"
                size="sm"
                type="password"
                value={jiraToken}
                autoComplete="current-password"
                onChange={(event) => setJiraToken(event.currentTarget.value)}
                placeholder="Jira API token"
              />
            </SettingsField>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmitJira}>
                {saveJiraTokenMutation.isPending ? <Spinner className="size-3" /> : null}
                Save token
              </Button>
            </div>
          </form>
        </SettingsBlock>
      ) : null}

      {connectionsPending ? (
        <SettingsBlock className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading Atlassian connections
        </SettingsBlock>
      ) : items.length === 0 ? (
        <SettingsEmpty
          icon={<KeyRoundIcon />}
          title="No Atlassian connections"
          description="Add a Bitbucket or Jira token to enable repository pull requests, diffs, and work-item links."
          className="py-8"
        />
      ) : (
        items.map((item) => (
          <SettingsRow
            key={item.connectionId}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <AtlassianProductIcon
                  products={item.products}
                  className="size-4 shrink-0 text-foreground/80"
                />
                <span className="truncate">{item.label}</span>
                <Badge variant={statusBadgeVariant(item.status)} size="sm" className="capitalize">
                  {item.status.replaceAll("_", " ")}
                </Badge>
                <Badge variant="outline" size="sm">
                  {formatConnectionKind(item.kind)}
                </Badge>
              </span>
            }
            description={
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                {item.accountEmail ? (
                  <RedactedAccount account={item.accountEmail} />
                ) : (
                  <span>No account email saved</span>
                )}
                <span aria-hidden>·</span>
                <span>{item.capabilities.join(" · ")}</span>
              </span>
            }
            control={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive-foreground"
                aria-label={`Delete ${item.label}`}
                disabled={disconnectMutation.isPending || item.readonly}
                onClick={() => disconnectMutation.mutate(item)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const scope = useSettingsEditingScope();
  return scope === "client" ? (
    <SettingsPageContainer>
      <SourceControlPreferences />
    </SettingsPageContainer>
  ) : (
    <NodeSourceControlSettingsPanel />
  );
}

function NodeSourceControlSettingsPanel() {
  const scope = useSettingsEditingScope();
  const settingsTarget = useSettingsTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsTarget?.environmentId ?? primaryEnvironmentId;
  const discovery = useSourceControlDiscovery({ environmentId });

  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    void refreshSourceControlDiscovery({ environmentId });
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  if (isInitialScanPending) {
    return (
      <SettingsPageContainer>
        <SourceControlSectionSkeleton title="Version control" headerAction={scanButton} />
        <SourceControlSectionSkeleton title="Hosting providers" />
      </SettingsPageContainer>
    );
  }

  const hasVcsItems = result.versionControlSystems.length > 0;
  const hasProviderItems = result.sourceControlProviders.length > 0;
  const hasDiscoveryItems = hasVcsItems || hasProviderItems;

  return (
    <SettingsPageContainer>
      {scope === "all" && <SourceControlPreferences />}
      {hasDiscoveryItems ? null : (
        <SettingsSection title="Hosting providers">
          <SettingsEmpty
            icon={<GitIcon className="size-4" />}
            title="Nothing detected yet"
            description="Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."
            action={
              <Button type="button" size="xs" onClick={handleScan} disabled={discovery.isPending}>
                <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
                Scan
              </Button>
            }
          />
        </SettingsSection>
      )}

      {hasVcsItems ? (
        <SettingsSection title="Version control" headerAction={scanButton}>
          {result.versionControlSystems.map((item) => (
            <DiscoveryItemRow key={`vcs:${item.kind}`} item={item} />
          ))}
        </SettingsSection>
      ) : null}

      {hasDiscoveryItems ? (
        <SettingsSection
          title="Hosting providers"
          description="Command-line tools on this device that power pull requests and reviews."
          headerAction={hasVcsItems ? null : scanButton}
        >
          {hasProviderItems ? (
            result.sourceControlProviders.map((item) => (
              <DiscoveryItemRow key={`provider:${item.kind}`} item={item} />
            ))
          ) : (
            <SettingsBlock className="text-xs leading-relaxed text-muted-foreground">
              {discovery.error ??
                "No source control providers were detected on the server. Install a CLI like git, gh, glab, or az on the server host, then rescan."}
            </SettingsBlock>
          )}
        </SettingsSection>
      ) : null}

      <AtlassianConfiguration environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
