import {
  ATLASSIAN_DEFAULT_BRANCH_TEMPLATE as DEFAULT_BRANCH_TEMPLATE,
  ATLASSIAN_DEFAULT_SUMMARY_TEMPLATE as DEFAULT_SUMMARY_TEMPLATE,
  ATLASSIAN_NONE_VALUE,
  atlassianConnectionsFor,
  bitbucketRemoteSuggestion,
  buildJiraProjectUnlinkInput,
  buildProjectAtlassianLinkSaveInput,
  isJiraLinked,
  nullableAtlassianConnectionId,
  projectAtlassianLinkFields,
  splitAtlassianProjectKeys,
} from "@ryco/client-runtime/projectSettings/atlassianLink";
import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@ryco/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useMutation, useQueryClient } from "../../rpc/queryClient";
import {
  invalidateAtlassian,
  useAtlassianConnections,
  useAtlassianProjectLink,
} from "../../rpc/useAtlassian";
import { invalidateWorkItems } from "../../rpc/useWorkItems";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { errorMessage } from "~/lib/errorMessage";

export {
  ATLASSIAN_NONE_VALUE,
  bitbucketRemoteSuggestion,
  nullableAtlassianConnectionId,
  splitAtlassianProjectKeys,
};

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
    () => atlassianConnectionsFor(connectionsQuery.data, "jira"),
    [connectionsQuery.data],
  );
  const bitbucketConnections = useMemo(
    () => atlassianConnectionsFor(connectionsQuery.data, "bitbucket"),
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
    const seeded = projectAtlassianLinkFields({
      link: projectLinkQuery.data,
      jiraConnections,
      bitbucketConnections,
      repositoryIdentity,
    });
    setJiraConnectionValue(seeded.jiraConnectionValue);
    setBitbucketConnectionValue(seeded.bitbucketConnectionValue);
    setJiraProjectKeys(seeded.jiraProjectKeys);
    setBitbucketWorkspace(seeded.bitbucketWorkspace);
    setBitbucketRepoSlug(seeded.bitbucketRepoSlug);
    setDefaultIssueTypeName(seeded.defaultIssueTypeName);
    setBranchNameTemplate(seeded.branchNameTemplate);
    setCommitMessageTemplate(seeded.commitMessageTemplate);
    setPullRequestTitleTemplate(seeded.pullRequestTitleTemplate);
    setSmartLinkingEnabled(seeded.smartLinkingEnabled);
    setAutoAttachWorkItems(seeded.autoAttachWorkItems);
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
      return client.atlassian.saveProjectLink(
        buildProjectAtlassianLinkSaveInput({
          projectId,
          existing: projectLinkQuery.data,
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
        }),
      );
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
          description: errorMessage(error, "The project link was not saved."),
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
          description: errorMessage(error, "The project link was not saved."),
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
    jiraLinked: isJiraLinked(projectLinkQuery.data),
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
