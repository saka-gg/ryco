import type {
  AtlassianConnectionId,
  AtlassianConnectionSummary,
  EnvironmentId,
  ProjectId,
  RepositoryIdentity,
} from "@ryco/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { buildJiraProjectUnlinkInput } from "../../lib/atlassianProjectLinks";
import { useMutation, useQueryClient } from "../../rpc/queryClient";
import {
  invalidateAtlassian,
  useAtlassianConnections,
  useAtlassianProjectLink,
} from "../../rpc/useAtlassian";
import { invalidateWorkItems } from "../../rpc/useWorkItems";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The select value for "no connection". */
export const ATLASSIAN_NONE_VALUE = "Not configured";

const DEFAULT_BRANCH_TEMPLATE = "{issueKey}-{titleSlug}";
const DEFAULT_SUMMARY_TEMPLATE = "{issueKey}: {summary}";

function atlassianConnectionValue(value: AtlassianConnectionId | null | undefined): string {
  return value ?? ATLASSIAN_NONE_VALUE;
}

export function nullableAtlassianConnectionId(value: string): AtlassianConnectionId | null {
  return value === ATLASSIAN_NONE_VALUE || value.trim().length === 0
    ? null
    : (value as AtlassianConnectionId);
}

export function splitAtlassianProjectKeys(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

/** A Bitbucket remote names its workspace and repository; offer them as defaults. */
export function bitbucketRemoteSuggestion(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): { workspace: string; repoSlug: string } {
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

/**
 * The project's Jira and Bitbucket link as an editable form: seeded from the
 * saved link (or the first connection and the repository's own names),
 * guarded so a refetch never overwrites an edit in progress, saved and
 * unlinked as one write. The projects page and the frozen phone dialog render
 * it differently but share every rule here.
 */
export function useProjectAtlassianLinkForm(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly repositoryIdentity: RepositoryIdentity | null | undefined;
}) {
  const { environmentId, projectId, repositoryIdentity } = input;
  const queryClient = useQueryClient();
  const connection = environmentId ? readEnvironmentConnection(environmentId) : null;
  const client = connection?.client ?? null;
  const ready = client !== null && environmentId !== null && projectId !== null;
  const [jiraConnectionValue, setJiraConnectionValue] = useState(ATLASSIAN_NONE_VALUE);
  const [bitbucketConnectionValue, setBitbucketConnectionValue] = useState(ATLASSIAN_NONE_VALUE);
  const [jiraProjectKeys, setJiraProjectKeys] = useState("");
  const [bitbucketWorkspace, setBitbucketWorkspace] = useState("");
  const [bitbucketRepoSlug, setBitbucketRepoSlug] = useState("");
  const [defaultIssueTypeName, setDefaultIssueTypeName] = useState("");
  const [branchNameTemplate, setBranchNameTemplate] = useState(DEFAULT_BRANCH_TEMPLATE);
  const [commitMessageTemplate, setCommitMessageTemplate] = useState(DEFAULT_SUMMARY_TEMPLATE);
  const [pullRequestTitleTemplate, setPullRequestTitleTemplate] =
    useState(DEFAULT_SUMMARY_TEMPLATE);
  const [smartLinkingEnabled, setSmartLinkingEnabled] = useState(true);
  const [autoAttachWorkItems, setAutoAttachWorkItems] = useState(true);
  const dirtyRef = useRef(false);
  const initializedTargetRef = useRef<string | null>(null);

  const projectLinkQuery = useAtlassianProjectLink({ environmentId, projectId, enabled: ready });
  const connectionsQuery = useAtlassianConnections({ environmentId, enabled: client !== null });

  const jiraConnections = useMemo(
    () => (connectionsQuery.data ?? []).filter(connectionProductFilter("jira")),
    [connectionsQuery.data],
  );
  const bitbucketConnections = useMemo(
    () => (connectionsQuery.data ?? []).filter(connectionProductFilter("bitbucket")),
    [connectionsQuery.data],
  );

  useEffect(() => {
    if (environmentId === null || projectId === null) return;
    const targetKey = `${environmentId}:${projectId}`;
    if (initializedTargetRef.current !== targetKey) {
      initializedTargetRef.current = targetKey;
      dirtyRef.current = false;
    }
    if (dirtyRef.current) return;
    const link = projectLinkQuery.data;
    const remote = bitbucketRemoteSuggestion(repositoryIdentity);
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
    setBranchNameTemplate(link?.branchNameTemplate ?? DEFAULT_BRANCH_TEMPLATE);
    setCommitMessageTemplate(link?.commitMessageTemplate ?? DEFAULT_SUMMARY_TEMPLATE);
    setPullRequestTitleTemplate(link?.pullRequestTitleTemplate ?? DEFAULT_SUMMARY_TEMPLATE);
    setSmartLinkingEnabled(link?.smartLinkingEnabled ?? true);
    setAutoAttachWorkItems(link?.autoAttachWorkItems ?? true);
  }, [
    bitbucketConnections,
    environmentId,
    jiraConnections,
    projectId,
    projectLinkQuery.data,
    repositoryIdentity,
  ]);

  /** Wraps a setter so the edit survives refetches until it is saved. */
  const edit =
    <T>(set: (value: T) => void) =>
    (value: T) => {
      dirtyRef.current = true;
      set(value);
    };

  const invalidateProjectSettings = () => {
    invalidateAtlassian({ environmentId });
    invalidateWorkItems({ environmentId, projectId });
    void queryClient.invalidateQueries({ queryKey: ["atlassian"] });
    void queryClient.invalidateQueries({ queryKey: ["workItems"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!client || projectId === null) throw new Error("Project connection is unavailable.");
      const branchTemplate = branchNameTemplate.trim();
      const commitTemplate = commitMessageTemplate.trim();
      const prTemplate = pullRequestTitleTemplate.trim();
      if (!branchTemplate || !commitTemplate || !prTemplate) {
        throw new Error("Branch, commit, and pull request templates cannot be empty.");
      }
      return client.atlassian.saveProjectLink({
        projectId,
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
      invalidateProjectSettings();
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
      if (!client || projectId === null) throw new Error("Project connection is unavailable.");
      return client.atlassian.saveProjectLink(
        buildJiraProjectUnlinkInput({ projectId, existing: projectLinkQuery.data ?? null }),
      );
    },
    onSuccess: () => {
      dirtyRef.current = false;
      setJiraConnectionValue(ATLASSIAN_NONE_VALUE);
      setJiraProjectKeys("");
      invalidateProjectSettings();
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

  const selectedJiraConnectionId = nullableAtlassianConnectionId(jiraConnectionValue);
  const selectedJiraConnection = jiraConnections.find(
    (candidate) => candidate.connectionId === selectedJiraConnectionId,
  );
  return {
    isLoading: projectLinkQuery.isLoading || connectionsQuery.isLoading,
    disabled: !ready || saveMutation.isPending || unlinkJiraMutation.isPending,
    hasConnections: jiraConnections.length > 0 || bitbucketConnections.length > 0,
    jiraConnections,
    bitbucketConnections,
    jiraLinked:
      projectLinkQuery.data?.jiraConnectionId !== null &&
      projectLinkQuery.data?.jiraConnectionId !== undefined &&
      projectLinkQuery.data.jiraProjectKeys.length > 0,
    selectedJiraConnectionId,
    selectedJiraSiteUrl:
      selectedJiraConnection?.baseUrl ?? projectLinkQuery.data?.jiraSiteUrl ?? "",
    fields: {
      jiraConnectionValue,
      bitbucketConnectionValue,
      jiraProjectKeys,
      bitbucketWorkspace,
      bitbucketRepoSlug,
      defaultIssueTypeName,
      branchNameTemplate,
      commitMessageTemplate,
      pullRequestTitleTemplate,
      smartLinkingEnabled,
      autoAttachWorkItems,
    },
    setters: {
      setJiraConnectionValue: edit(setJiraConnectionValue),
      setBitbucketConnectionValue: edit(setBitbucketConnectionValue),
      setJiraProjectKeys: edit(setJiraProjectKeys),
      setBitbucketWorkspace: edit(setBitbucketWorkspace),
      setBitbucketRepoSlug: edit(setBitbucketRepoSlug),
      setDefaultIssueTypeName: edit(setDefaultIssueTypeName),
      setBranchNameTemplate: edit(setBranchNameTemplate),
      setCommitMessageTemplate: edit(setCommitMessageTemplate),
      setPullRequestTitleTemplate: edit(setPullRequestTitleTemplate),
      setSmartLinkingEnabled: edit(setSmartLinkingEnabled),
      setAutoAttachWorkItems: edit(setAutoAttachWorkItems),
    },
    save: () => saveMutation.mutate(),
    saving: saveMutation.isPending,
    unlinkJira: () => unlinkJiraMutation.mutate(),
    unlinking: unlinkJiraMutation.isPending,
  };
}
