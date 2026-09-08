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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
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
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readEnvironmentConnection } from "~/environments/runtime";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useSettingsTarget } from "../../settingsTarget";

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

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
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
  const enabled =
    item.status === "available" && (isProviderDiscoveryItem(item) || item.implemented);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const authHost = auth ? optionLabel(auth.host) : null;

  return (
    <div
      className={cn(
        "border-t border-border/60 first:border-t-0",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-4 py-3.5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {item.label}
              </h3>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming Soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              {itemSummary({ item, auth, authAccount, authHost })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {!isVcsNotReady(item) ? (
              <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
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
    <>
      <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5 sm:px-5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          <KeyRoundIcon className="size-3" aria-hidden />
          Atlassian
        </h3>
      </div>
      <div className="border-t border-border/60 px-4 py-4 sm:px-5">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr] sm:items-end" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="bitbucket-token-label" className="text-xs">
              Label
            </Label>
            <Input
              id="bitbucket-token-label"
              size="sm"
              value={bitbucketLabel}
              autoComplete="organization"
              onChange={(event) => setBitbucketLabel(event.currentTarget.value)}
              placeholder="Bitbucket"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bitbucket-token-email" className="text-xs">
              Email
            </Label>
            <Input
              id="bitbucket-token-email"
              size="sm"
              type="email"
              value={bitbucketEmail}
              autoComplete="username"
              onChange={(event) => setBitbucketEmail(event.currentTarget.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="bitbucket-token-secret" className="text-xs">
              Bitbucket app password
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="bitbucket-token-secret"
                size="sm"
                type="password"
                value={bitbucketToken}
                autoComplete="current-password"
                onChange={(event) => setBitbucketToken(event.currentTarget.value)}
                placeholder="Stored locally in the server secret store"
              />
              <Button
                type="submit"
                size="sm"
                className="h-7.5 shrink-0 gap-1.5 px-3 text-xs"
                disabled={!canSubmit}
              >
                {saveTokenMutation.isPending ? <Spinner className="size-3" /> : null}
                Save Token
              </Button>
            </div>
          </div>
        </form>
      </div>

      <div className="border-t border-border/60 px-4 py-4 sm:px-5">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr] sm:items-end"
          onSubmit={handleJiraSubmit}
        >
          <div className="space-y-1.5">
            <Label htmlFor="jira-token-label" className="text-xs">
              Label
            </Label>
            <Input
              id="jira-token-label"
              size="sm"
              value={jiraLabel}
              autoComplete="organization"
              onChange={(event) => setJiraLabel(event.currentTarget.value)}
              placeholder="Jira"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jira-token-email" className="text-xs">
              Email
            </Label>
            <Input
              id="jira-token-email"
              size="sm"
              type="email"
              value={jiraEmail}
              autoComplete="username"
              onChange={(event) => setJiraEmail(event.currentTarget.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="jira-site-url" className="text-xs">
              Jira site URL
            </Label>
            <Input
              id="jira-site-url"
              size="sm"
              value={jiraSiteUrl}
              inputMode="url"
              autoComplete="url"
              onChange={(event) => setJiraSiteUrl(event.currentTarget.value)}
              placeholder="https://your-team.atlassian.net"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="jira-token-secret" className="text-xs">
              Jira API token
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="jira-token-secret"
                size="sm"
                type="password"
                value={jiraToken}
                autoComplete="current-password"
                onChange={(event) => setJiraToken(event.currentTarget.value)}
                placeholder="Stored locally in the server secret store"
              />
              <Button
                type="submit"
                size="sm"
                className="h-7.5 shrink-0 gap-1.5 px-3 text-xs"
                disabled={!canSubmitJira}
              >
                {saveJiraTokenMutation.isPending ? <Spinner className="size-3" /> : null}
                Save Jira
              </Button>
            </div>
          </div>
        </form>
      </div>

      <div className="border-t border-border/60">
        {connectionsPending ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            <Spinner className="size-3.5" />
            Loading Atlassian connections
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
            No Atlassian connections are stored yet. Add Bitbucket and Jira tokens to enable
            repository PRs, diffs, and work-item links.
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.connectionId}
              className="flex flex-col gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-5"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <AtlassianProductIcon
                    products={item.products}
                    className="size-4 text-foreground/80"
                  />
                  <h3 className="truncate text-[13px] font-semibold text-foreground">
                    {item.label}
                  </h3>
                  <Badge variant={statusBadgeVariant(item.status)} size="sm">
                    {item.status.replace("_", " ")}
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {formatConnectionKind(item.kind)}
                  </Badge>
                </div>
                <p className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground">
                  {item.accountEmail ? (
                    <RedactedAccount account={item.accountEmail} />
                  ) : (
                    <span>No account email saved</span>
                  )}
                  <span aria-hidden>·</span>
                  <span>{item.capabilities.join(", ")}</span>
                </p>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-7 self-start text-muted-foreground hover:text-destructive sm:self-auto"
                aria-label={`Delete ${item.label}`}
                disabled={disconnectMutation.isPending || item.readonly}
                onClick={() => disconnectMutation.mutate(item)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export function SourceControlSettingsPanel() {
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
        <SourceControlSectionSkeleton title="Version Control" headerAction={scanButton} />
        <SourceControlSectionSkeleton title="Source Control Providers" />
      </SettingsPageContainer>
    );
  }

  const hasVcsItems = result.versionControlSystems.length > 0;
  const hasProviderItems = result.sourceControlProviders.length > 0;
  const hasDiscoveryItems = hasVcsItems || hasProviderItems;

  return (
    <SettingsPageContainer>
      <SourceControlPreferences />
      {hasDiscoveryItems ? null : (
        <SettingsSection title="Source Control Providers">
          <Empty className="min-h-56 border-t border-border/60 first:border-t-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitIcon className="size-4" />
              </EmptyMedia>
              <EmptyTitle>Nothing detected yet</EmptyTitle>
              <EmptyDescription>
                Install Git on the server, add optional hosting integrations or credentials your
                workspace needs, then rescan.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" size="xs" onClick={handleScan} disabled={discovery.isPending}>
                <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
                Scan
              </Button>
            </EmptyContent>
          </Empty>
          <AtlassianConfiguration environmentId={environmentId} />
        </SettingsSection>
      )}

      {hasVcsItems ? (
        <SettingsSection title="Version Control" headerAction={scanButton}>
          {result.versionControlSystems.map((item) => (
            <DiscoveryItemRow key={`vcs:${item.kind}`} item={item} />
          ))}
        </SettingsSection>
      ) : null}

      {hasDiscoveryItems ? (
        <SettingsSection
          title="Source Control Providers"
          headerAction={hasVcsItems ? null : scanButton}
        >
          {hasProviderItems ? (
            result.sourceControlProviders.map((item) => (
              <DiscoveryItemRow key={`provider:${item.kind}`} item={item} />
            ))
          ) : (
            <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {discovery.error ??
                  "No source control providers were detected on the server. Install a CLI like git, gh, glab, or az on the server host, then rescan."}
              </p>
            </div>
          )}
          <AtlassianConfiguration environmentId={environmentId} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
