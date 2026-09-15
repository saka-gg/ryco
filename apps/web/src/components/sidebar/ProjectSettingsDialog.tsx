import { ProjectMemorySettings } from "../projectMemory/ProjectMemorySettings";
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "~/rpc/queryClient";
import {
  invalidateAtlassian,
  useAtlassianConnections,
  useAtlassianProjectLink,
} from "~/rpc/useAtlassian";
import { invalidateWorkItems } from "~/rpc/useWorkItems";
import {
  PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS,
  type AtlassianConnectionId,
  type AtlassianConnectionSummary,
  type RepositoryIdentity,
} from "@ryco/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { buildJiraProjectUnlinkInput } from "../../lib/atlassianProjectLinks";
import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "../../lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  type Icon,
} from "../Icons";
import { JiraProjectPicker } from "../atlassian/JiraProjectPicker";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveRepositoryProviderIcon(provider: string | undefined): Icon {
  switch (provider) {
    case "github":
      return GitHubIcon;
    case "gitlab":
      return GitLabIcon;
    case "forgejo":
      return ForgejoIcon;
    case "azure-devops":
      return AzureDevOpsIcon;
    case "bitbucket":
      return BitbucketIcon;
    default:
      return GitIcon;
  }
}

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

type ProjectSettingsSection = "general" | "location" | "atlassian" | "ai" | "memory";

const PROJECT_SETTINGS_NAV_ITEMS = [
  { id: "general", label: "General", Icon: Settings2Icon },
  { id: "location", label: "Location", Icon: FolderOpenIcon },
  { id: "atlassian", label: "Atlassian", Icon: SlidersHorizontalIcon },
  { id: "ai", label: "AI", Icon: SparklesIcon },
  { id: "memory", label: "Memory", Icon: SparklesIcon },
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProjectSettingsDialogProps {
  open: boolean;
  saving: boolean;
  target: SidebarProjectGroupMember | null;
  // General section
  title: string;
  customAvatarContentHash: string | null;
  projectAvatarUploadUnavailableReason: string | null;
  preferredRemoteName: string | null;
  // Location section
  workspaceRoot: string;
  // AI section
  customSystemPrompt: string;
  // Handlers
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  onWorkspaceRootChange: (value: string) => void;
  onCustomSystemPromptChange: (value: string) => void;
  onPreferredRemoteChange: (value: string | null) => void;
  onPickWorkspaceRoot: () => void;
  onOpenRemote: (member: SidebarProjectGroupMember, remoteName: string) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// General section
// ---------------------------------------------------------------------------

function ProjectSettingsGeneralSection(props: {
  target: SidebarProjectGroupMember;
  title: string;
  customAvatarContentHash: string | null;
  projectAvatarUploadUnavailableReason: string | null;
  preferredRemoteName: string | null;
  onTitleChange: (value: string) => void;
  onPreferredRemoteChange: (value: string | null) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onOpenRemote: (member: SidebarProjectGroupMember, remoteName: string) => void;
}) {
  const remotes = props.target.repositoryIdentity?.remotes ?? [];
  const autoRemoteName = props.target.repositoryIdentity?.locator.remoteName ?? null;
  const selectedRemoteName =
    props.preferredRemoteName && remotes.some((r) => r.name === props.preferredRemoteName)
      ? props.preferredRemoteName
      : null; // null means auto
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const triggerUpload = () => {
    if (!props.projectAvatarUploadUnavailableReason) fileInputRef.current?.click();
  };
  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      await props.onUploadAvatar(file);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex items-start gap-4">
        <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-secondary text-muted-foreground shadow-xs">
          <ProjectFavicon
            environmentId={props.target.environmentId}
            cwd={props.target.cwd}
            projectId={props.target.id}
            customAvatarContentHash={props.customAvatarContentHash}
            fillContainer
          />
          {uploading ? (
            <div className="absolute inset-0 grid place-items-center bg-background/60 text-xs">
              …
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-xs font-medium text-foreground">Project image</div>
          <p className="text-[11px] text-muted-foreground">
            {props.projectAvatarUploadUnavailableReason
              ? props.projectAvatarUploadUnavailableReason
              : props.customAvatarContentHash
                ? "PNG, JPG, or WebP · up to 2 MB"
                : "Using auto-detected favicon · upload to override"}
          </p>
          <div className="flex gap-2 pt-1">
            <Button
              size="xs"
              variant="outline"
              onClick={triggerUpload}
              disabled={uploading || props.projectAvatarUploadUnavailableReason !== null}
              title={props.projectAvatarUploadUnavailableReason ?? undefined}
            >
              Upload
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void props.onRemoveAvatar()}
              disabled={!props.customAvatarContentHash || uploading}
            >
              Remove
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={props.projectAvatarUploadUnavailableReason !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="space-y-1.5">
        <label htmlFor="project-display-name" className="text-xs font-medium text-foreground">
          Display name
        </label>
        <Input
          id="project-display-name"
          aria-label="Project display name"
          value={props.title}
          onChange={(event) => props.onTitleChange(event.target.value)}
        />
      </section>

      {remotes.length > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-foreground">Linked repositories</div>
            {remotes.length > 1 ? (
              <span className="text-[11px] text-muted-foreground">{remotes.length} remotes</span>
            ) : null}
          </div>
          {remotes.length > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              Pick which remote the sidebar "Open remote" uses.
            </p>
          ) : null}
          <div className="overflow-hidden rounded-lg border border-border/70">
            {remotes.length > 1 ? (
              <button
                type="button"
                onClick={() => props.onPreferredRemoteChange(null)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-border/70 px-3 py-2 text-left",
                  selectedRemoteName === null && "bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border",
                    selectedRemoteName === null
                      ? "border-foreground"
                      : "border-muted-foreground/40",
                  )}
                  aria-hidden="true"
                >
                  {selectedRemoteName === null ? (
                    <span className="size-2 rounded-full bg-foreground" />
                  ) : null}
                </span>
                <span className="text-xs">
                  Auto-detect{autoRemoteName ? ` (currently: ${autoRemoteName})` : ""}
                </span>
              </button>
            ) : null}
            {remotes.map((remote, index) => {
              const isSelected =
                selectedRemoteName === remote.name ||
                (selectedRemoteName === null &&
                  remote.name === autoRemoteName &&
                  remotes.length === 1);
              const ProviderIcon = resolveRepositoryProviderIcon(remote.provider ?? undefined);
              return (
                <div
                  key={remote.name}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2",
                    index > 0 || remotes.length > 1 ? "border-t border-border/70" : "",
                    isSelected && "bg-accent/50",
                  )}
                >
                  {remotes.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => props.onPreferredRemoteChange(remote.name)}
                      className="shrink-0"
                      aria-label={`Use ${remote.name} as primary`}
                    >
                      <span
                        className={cn(
                          "grid size-4 place-items-center rounded-full border",
                          isSelected ? "border-foreground" : "border-muted-foreground/40",
                        )}
                      >
                        {isSelected ? <span className="size-2 rounded-full bg-foreground" /> : null}
                      </span>
                    </button>
                  ) : null}
                  <ProviderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{remote.name}</span>
                      {isSelected && remotes.length > 1 ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          primary
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {remote.ownerRepo ?? remote.url}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onOpenRemote(props.target, remote.name)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    Open
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Location section
// ---------------------------------------------------------------------------

function ProjectSettingsLocationSection(props: {
  workspaceRoot: string;
  projectId: string;
  onWorkspaceRootChange: (value: string) => void;
  onPickWorkspaceRoot: () => void;
  onSave: () => void;
}) {
  const worktreesPath = `~/.ryco/worktrees/${props.projectId}/`;
  return (
    <div className="space-y-6">
      <section className="space-y-1.5">
        <label htmlFor="project-root" className="text-xs font-medium text-foreground">
          Project root
        </label>
        <p className="text-[11px] text-muted-foreground">
          The absolute path the project is anchored to.
        </p>
        <div className="flex gap-2">
          <Input
            id="project-root"
            aria-label="Project root"
            value={props.workspaceRoot}
            onChange={(event) => props.onWorkspaceRootChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onSave();
              }
            }}
          />
          <Button variant="outline" onClick={props.onPickWorkspaceRoot}>
            <FolderOpenIcon className="size-4" />
            Browse
          </Button>
        </div>
      </section>

      <section className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">Worktrees location</div>
        <p className="text-[11px] text-muted-foreground">
          New worktrees for this project are created here. Each one is named{" "}
          <span className="font-mono">{"<branch>__<word>"}</span>, where{" "}
          <span className="font-mono">{"<word>"}</span> is a random 5-letter suffix that
          disambiguates multiple checkouts of the same branch.
        </p>
        <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2">
          <div className="truncate font-mono text-xs">{worktreesPath}</div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI section
// ---------------------------------------------------------------------------

function ProjectSettingsAiSection(props: {
  target: SidebarProjectGroupMember;
  customSystemPrompt: string;
  onCustomSystemPromptChange: (value: string) => void;
}) {
  const length = props.customSystemPrompt.length;
  const limit = PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;
  const warnThreshold = Math.floor(limit * 0.9);
  const counterClass =
    length >= limit
      ? "text-destructive"
      : length >= warnThreshold
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label
          htmlFor="project-custom-system-prompt"
          className="text-xs font-medium text-foreground"
        >
          Custom system prompt
        </label>
        <p className="text-[11px] text-muted-foreground">
          Appended to every assistant prompt for this project.
        </p>
        <div className="relative">
          <Textarea
            id="project-custom-system-prompt"
            aria-label="Custom system prompt"
            value={props.customSystemPrompt}
            maxLength={limit}
            placeholder="Always use TypeScript."
            className="min-h-32 resize-y pr-20"
            onChange={(event) => props.onCustomSystemPromptChange(event.target.value)}
          />
          <span
            className={cn(
              "pointer-events-none absolute bottom-2 right-3 text-[11px]",
              counterClass,
            )}
          >
            {length} / {limit}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atlassian helpers
// ---------------------------------------------------------------------------

const ATLASSIAN_NONE_VALUE = "Not configured";

function atlassianConnectionValue(value: AtlassianConnectionId | null | undefined): string {
  return value ?? ATLASSIAN_NONE_VALUE;
}

function nullableAtlassianConnectionId(value: string): AtlassianConnectionId | null {
  return value === ATLASSIAN_NONE_VALUE || value.trim().length === 0
    ? null
    : (value as AtlassianConnectionId);
}

function splitAtlassianProjectKeys(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function bitbucketRemoteSuggestion(repositoryIdentity: RepositoryIdentity | null | undefined): {
  workspace: string;
  repoSlug: string;
} {
  if (repositoryIdentity?.provider?.toLowerCase() !== "bitbucket") {
    return { workspace: "", repoSlug: "" };
  }
  return {
    workspace: repositoryIdentity.owner ?? "",
    repoSlug: repositoryIdentity.name ?? "",
  };
}

function connectionProductFilter(product: "jira" | "bitbucket") {
  return (connection: AtlassianConnectionSummary) =>
    connection.status === "connected" && connection.products.includes(product);
}

// ---------------------------------------------------------------------------
// Atlassian section
// ---------------------------------------------------------------------------

function ProjectAtlassianSettingsSection(props: { target: SidebarProjectGroupMember | null }) {
  const target = props.target;
  const queryClient = useQueryClient();
  const connection = target ? readEnvironmentConnection(target.environmentId) : null;
  const client = connection?.client ?? null;
  const [jiraConnectionValue, setJiraConnectionValue] = useState(ATLASSIAN_NONE_VALUE);
  const [bitbucketConnectionValue, setBitbucketConnectionValue] = useState(ATLASSIAN_NONE_VALUE);
  const [jiraProjectKeys, setJiraProjectKeys] = useState("");
  const [bitbucketWorkspace, setBitbucketWorkspace] = useState("");
  const [bitbucketRepoSlug, setBitbucketRepoSlug] = useState("");
  const [defaultIssueTypeName, setDefaultIssueTypeName] = useState("");
  const [branchNameTemplate, setBranchNameTemplate] = useState("{issueKey}-{titleSlug}");
  const [commitMessageTemplate, setCommitMessageTemplate] = useState("{issueKey}: {summary}");
  const [pullRequestTitleTemplate, setPullRequestTitleTemplate] = useState("{issueKey}: {summary}");
  const [smartLinkingEnabled, setSmartLinkingEnabled] = useState(true);
  const [autoAttachWorkItems, setAutoAttachWorkItems] = useState(true);
  const dirtyRef = useRef(false);
  const initializedTargetRef = useRef<string | null>(null);

  const projectLinkQuery = useAtlassianProjectLink({
    environmentId: target?.environmentId ?? null,
    projectId: target?.id ?? null,
    enabled: client !== null && target !== null,
  });

  const connectionsQuery = useAtlassianConnections({
    environmentId: target?.environmentId ?? null,
    enabled: client !== null,
  });

  const jiraConnections = useMemo(
    () => (connectionsQuery.data ?? []).filter(connectionProductFilter("jira")),
    [connectionsQuery.data],
  );
  const bitbucketConnections = useMemo(
    () => (connectionsQuery.data ?? []).filter(connectionProductFilter("bitbucket")),
    [connectionsQuery.data],
  );

  useEffect(() => {
    if (!target) return;
    const targetKey = `${target.environmentId}:${target.id}`;
    if (initializedTargetRef.current !== targetKey) {
      initializedTargetRef.current = targetKey;
      dirtyRef.current = false;
    }
    if (dirtyRef.current) return;
    const link = projectLinkQuery.data;
    const remote = bitbucketRemoteSuggestion(target.repositoryIdentity);
    setJiraConnectionValue(
      atlassianConnectionValue(link?.jiraConnectionId ?? jiraConnections[0]?.connectionId),
    );
    setBitbucketConnectionValue(
      atlassianConnectionValue(
        link?.bitbucketConnectionId ?? bitbucketConnections[0]?.connectionId,
      ),
    );
    setJiraProjectKeys(link?.jiraProjectKeys.join(", ") ?? "");
    setBitbucketWorkspace(link?.bitbucketWorkspace ?? remote.workspace);
    setBitbucketRepoSlug(link?.bitbucketRepoSlug ?? remote.repoSlug);
    setDefaultIssueTypeName(link?.defaultIssueTypeName ?? "");
    setBranchNameTemplate(link?.branchNameTemplate ?? "{issueKey}-{titleSlug}");
    setCommitMessageTemplate(link?.commitMessageTemplate ?? "{issueKey}: {summary}");
    setPullRequestTitleTemplate(link?.pullRequestTitleTemplate ?? "{issueKey}: {summary}");
    setSmartLinkingEnabled(link?.smartLinkingEnabled ?? true);
    setAutoAttachWorkItems(link?.autoAttachWorkItems ?? true);
  }, [bitbucketConnections, jiraConnections, projectLinkQuery.data, target]);

  const markDirty = () => {
    dirtyRef.current = true;
  };

  const invalidateAtlassianProjectSettings = () => {
    invalidateAtlassian({ environmentId: target?.environmentId ?? null });
    invalidateWorkItems({
      environmentId: target?.environmentId ?? null,
      projectId: target?.id ?? null,
    });
    void queryClient.invalidateQueries({ queryKey: ["atlassian"] });
    void queryClient.invalidateQueries({ queryKey: ["workItems"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!client || !target) throw new Error("Project connection is unavailable.");
      const branchTemplate = branchNameTemplate.trim();
      const commitTemplate = commitMessageTemplate.trim();
      const prTemplate = pullRequestTitleTemplate.trim();
      if (!branchTemplate || !commitTemplate || !prTemplate) {
        throw new Error("Branch, commit, and pull request templates cannot be empty.");
      }
      return client.atlassian.saveProjectLink({
        projectId: target.id,
        jiraConnectionId: nullableAtlassianConnectionId(jiraConnectionValue),
        bitbucketConnectionId: nullableAtlassianConnectionId(bitbucketConnectionValue),
        jiraCloudId: projectLinkQuery.data?.jiraCloudId ?? null,
        jiraSiteUrl: null,
        jiraProjectKeys: splitAtlassianProjectKeys(jiraProjectKeys),
        bitbucketWorkspace: bitbucketWorkspace.trim() || null,
        bitbucketRepoSlug: bitbucketRepoSlug.trim() || null,
        defaultIssueTypeName: defaultIssueTypeName.trim() || null,
        branchNameTemplate: branchTemplate,
        commitMessageTemplate: commitTemplate,
        pullRequestTitleTemplate: prTemplate,
        smartLinkingEnabled,
        autoAttachWorkItems,
      });
    },
    onSuccess: () => {
      dirtyRef.current = false;
      invalidateAtlassianProjectSettings();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Atlassian project settings saved",
          description: "Jira and Bitbucket defaults were updated for this project.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save Atlassian project settings",
          description: error instanceof Error ? error.message : "The project link was not saved.",
        }),
      );
    },
  });

  const unlinkJiraMutation = useMutation({
    mutationFn: async () => {
      if (!client || !target) throw new Error("Project connection is unavailable.");
      return client.atlassian.saveProjectLink(
        buildJiraProjectUnlinkInput({
          projectId: target.id,
          existing: projectLinkQuery.data ?? null,
        }),
      );
    },
    onSuccess: () => {
      dirtyRef.current = false;
      setJiraConnectionValue(ATLASSIAN_NONE_VALUE);
      setJiraProjectKeys("");
      invalidateAtlassianProjectSettings();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Jira project unlinked",
          description: "Bitbucket mapping and project templates were left unchanged.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not unlink Jira project",
          description: error instanceof Error ? error.message : "The project link was not saved.",
        }),
      );
    },
  });

  const isLoading = projectLinkQuery.isLoading || connectionsQuery.isLoading;
  const disabled =
    client === null || target === null || saveMutation.isPending || unlinkJiraMutation.isPending;
  const jiraLinked =
    projectLinkQuery.data?.jiraConnectionId !== null &&
    projectLinkQuery.data?.jiraConnectionId !== undefined &&
    projectLinkQuery.data.jiraProjectKeys.length > 0;
  const selectedJiraConnectionId = nullableAtlassianConnectionId(jiraConnectionValue);
  const selectedJiraConnection = jiraConnections.find(
    (connection) => connection.connectionId === selectedJiraConnectionId,
  );
  const selectedJiraSiteUrl =
    selectedJiraConnection?.baseUrl ?? projectLinkQuery.data?.jiraSiteUrl ?? "";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">Atlassian workflow</div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Project-scoped Jira, Bitbucket, and smart-link defaults.
            </p>
          </div>
        </div>
        {isLoading ? (
          <span className="text-[11px] text-muted-foreground">Loading</span>
        ) : (
          <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Project defaults
          </span>
        )}
      </div>

      <section className="space-y-3">
        <div className="text-xs font-medium text-foreground">Connections</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Jira connection</label>
            <Select
              value={jiraConnectionValue}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  markDirty();
                  setJiraConnectionValue(value);
                }
              }}
            >
              <SelectTrigger size="sm" disabled={disabled}>
                <SelectValue placeholder="Select Jira connection" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ATLASSIAN_NONE_VALUE}>Not configured</SelectItem>
                {jiraConnections.map((item) => (
                  <SelectItem key={item.connectionId} value={item.connectionId}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Bitbucket connection</label>
            <Select
              value={bitbucketConnectionValue}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  markDirty();
                  setBitbucketConnectionValue(value);
                }
              }}
            >
              <SelectTrigger size="sm" disabled={disabled}>
                <SelectValue placeholder="Select Bitbucket connection" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ATLASSIAN_NONE_VALUE}>Not configured</SelectItem>
                {bitbucketConnections.map((item) => (
                  <SelectItem key={item.connectionId} value={item.connectionId}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-xs font-medium text-foreground">Repository mapping</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProjectSettingsField label="Jira project keys">
            <JiraProjectPicker
              environmentId={target?.environmentId ?? null}
              connectionId={selectedJiraConnectionId}
              siteUrl={selectedJiraSiteUrl}
              projectKeys={jiraProjectKeys}
              disabled={disabled}
              onProjectKeysChange={(value) => {
                markDirty();
                setJiraProjectKeys(value);
              }}
            />
            <Input
              size="sm"
              value={jiraProjectKeys}
              disabled={disabled}
              placeholder="WEB, API"
              onChange={(event) => {
                markDirty();
                setJiraProjectKeys(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
          <ProjectSettingsField label="Bitbucket workspace">
            <Input
              size="sm"
              value={bitbucketWorkspace}
              disabled={disabled}
              placeholder="workspace"
              onChange={(event) => {
                markDirty();
                setBitbucketWorkspace(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
          <ProjectSettingsField label="Bitbucket repo slug">
            <Input
              size="sm"
              value={bitbucketRepoSlug}
              disabled={disabled}
              placeholder="repo-slug"
              onChange={(event) => {
                markDirty();
                setBitbucketRepoSlug(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-xs font-medium text-foreground">Templates</div>
        <div className="grid gap-3">
          <ProjectSettingsField label="Default issue type">
            <Input
              size="sm"
              value={defaultIssueTypeName}
              disabled={disabled}
              placeholder="Task"
              onChange={(event) => {
                markDirty();
                setDefaultIssueTypeName(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
          <ProjectSettingsField label="Branch template">
            <Input
              size="sm"
              value={branchNameTemplate}
              disabled={disabled}
              onChange={(event) => {
                markDirty();
                setBranchNameTemplate(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
          <ProjectSettingsField label="Commit template">
            <Input
              size="sm"
              value={commitMessageTemplate}
              disabled={disabled}
              onChange={(event) => {
                markDirty();
                setCommitMessageTemplate(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
          <ProjectSettingsField label="PR title template">
            <Input
              size="sm"
              value={pullRequestTitleTemplate}
              disabled={disabled}
              onChange={(event) => {
                markDirty();
                setPullRequestTitleTemplate(event.currentTarget.value);
              }}
            />
          </ProjectSettingsField>
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-xs font-medium text-foreground">Automation</div>
        <div className="grid gap-2">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-xs">
            <span>Smart-link Jira keys in branches, commits, and PRs</span>
            <Switch
              checked={smartLinkingEnabled}
              disabled={disabled}
              onCheckedChange={(checked) => {
                markDirty();
                setSmartLinkingEnabled(Boolean(checked));
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-xs">
            <span>Attach linked work items to project explorer workflows</span>
            <Switch
              checked={autoAttachWorkItems}
              disabled={disabled}
              onCheckedChange={(checked) => {
                markDirty();
                setAutoAttachWorkItems(Boolean(checked));
              }}
            />
          </label>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-4">
        <p className="text-[11px] text-muted-foreground">
          Tokens live in Source Control settings. These defaults belong only to this project.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive-outline"
            className="h-8"
            disabled={disabled || !jiraLinked}
            onClick={() => unlinkJiraMutation.mutate()}
          >
            {unlinkJiraMutation.isPending ? "Unlinking..." : "Unlink Jira"}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={disabled}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "Saving..." : "Save Atlassian"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectSettingsField
// ---------------------------------------------------------------------------

function ProjectSettingsField(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const [section, setSection] = useState<ProjectSettingsSection>("general");
  useEffect(() => {
    if (props.open) setSection("general");
  }, [props.open, props.target?.id]);
  const target = props.target;
  if (!target) return null;

  const headerSubtitle = target.environmentLabel
    ? `${target.name} · ${target.environmentLabel}`
    : target.name;
  const activeSectionIndex = Math.max(
    0,
    PROJECT_SETTINGS_NAV_ITEMS.findIndex((item) => item.id === section),
  );

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="project-glass-surface h-[min(70vh,620px)] max-w-[760px] overflow-hidden p-0 duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-ending-style:translate-y-4 data-starting-style:translate-y-4"
        bottomStickOnMobile={false}
        showCloseButton={true}
        surface="glass"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold">Project settings</DialogTitle>
            <p className="truncate text-xs text-muted-foreground">{headerSubtitle}</p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-row">
          <nav className="relative isolate flex w-12 shrink-0 flex-col gap-1 border-r border-border p-2 sm:w-48">
            <span
              className="pointer-events-none absolute top-2 right-2 left-2 z-0 h-9 rounded-md bg-accent transition-transform duration-[240ms] ease-out"
              style={{ transform: `translateY(${activeSectionIndex * 2.5}rem)` }}
              aria-hidden
            />
            {PROJECT_SETTINGS_NAV_ITEMS.map(({ id, label, Icon }) => {
              const isActive = section === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  className={cn(
                    "relative z-10 flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-hidden ring-ring transition-colors duration-150 focus-visible:ring-2",
                    isActive
                      ? "font-medium text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      isActive ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  />
                  <span className="hidden truncate sm:inline">{label}</span>
                </button>
              );
            })}
          </nav>

          <ScrollArea className="min-h-0 flex-1 min-w-0">
            <div className="mx-auto max-w-[520px] px-6 py-6">
              {section === "general" ? (
                <ProjectSettingsGeneralSection
                  target={target}
                  title={props.title}
                  customAvatarContentHash={props.customAvatarContentHash}
                  projectAvatarUploadUnavailableReason={props.projectAvatarUploadUnavailableReason}
                  preferredRemoteName={props.preferredRemoteName}
                  onTitleChange={props.onTitleChange}
                  onPreferredRemoteChange={props.onPreferredRemoteChange}
                  onUploadAvatar={props.onUploadAvatar}
                  onRemoveAvatar={props.onRemoveAvatar}
                  onOpenRemote={props.onOpenRemote}
                />
              ) : section === "location" ? (
                <ProjectSettingsLocationSection
                  workspaceRoot={props.workspaceRoot}
                  projectId={target.id}
                  onWorkspaceRootChange={props.onWorkspaceRootChange}
                  onPickWorkspaceRoot={props.onPickWorkspaceRoot}
                  onSave={props.onSave}
                />
              ) : section === "memory" ? (
                <ProjectMemorySettings environmentId={target.environmentId} projectId={target.id} />
              ) : section === "atlassian" ? (
                <ProjectAtlassianSettingsSection target={target} />
              ) : (
                <ProjectSettingsAiSection
                  target={target}
                  customSystemPrompt={props.customSystemPrompt}
                  onCustomSystemPromptChange={props.onCustomSystemPromptChange}
                />
              )}
            </div>
          </ScrollArea>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          {section === "atlassian" || section === "memory" ? null : (
            <Button onClick={props.onSave} disabled={props.saving}>
              {props.saving ? "Saving…" : "Save changes"}
            </Button>
          )}
        </footer>
      </DialogPopup>
    </Dialog>
  );
}
