import {
  ATLASSIAN_NONE_VALUE,
  atlassianConnectionsFor,
  buildJiraProjectUnlinkInput,
  buildProjectAtlassianLinkSaveInput,
  isJiraLinked,
  projectAtlassianLinkFields,
  type ProjectAtlassianLinkFields,
} from "@ryco/client-runtime/projectSettings/atlassianLink";
import type {
  AtlassianConnectionSummary,
  AtlassianProjectLink,
  EnvironmentId,
  ProjectId,
  RepositoryIdentity,
} from "@ryco/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { readRpcClient, subscribeEnvironmentApis } from "../../connection/environmentApi";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { ProjectSettingsSection, SectionMessage } from "./ProjectSettingsSection";
import { atlassianConnectionLabel, runSettingsWrite } from "./projectSettingsModel";

type AtlassianClient = NonNullable<ReturnType<typeof readRpcClient>>["atlassian"];

/** The machine's Atlassian RPCs while it is connected, re-read as connections change. */
function useAtlassianClient(environmentId: EnvironmentId): AtlassianClient | undefined {
  const read = useCallback(() => readRpcClient(environmentId)?.atlassian, [environmentId]);
  return useSyncExternalStore(subscribeEnvironmentApis, read, read);
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string; readonly attempt: number }
  | {
      readonly status: "ready";
      readonly connections: readonly AtlassianConnectionSummary[];
      readonly link: AtlassianProjectLink | null;
    };

const loadFailure = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "The Jira and Bitbucket link could not be read.";

/**
 * Which Jira projects and Bitbucket repository this project maps to, and the templates and smart
 * links built from them, on its machine. Credentials are connected in the desktop app's Settings;
 * only this project's mapping is edited here. Owner-only: the screen leaves this section out for
 * anyone else. The templates and link switches fold away; most projects never change them.
 */
export function ProjectAtlassianSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly machineLabel: string;
  readonly repositoryIdentity: RepositoryIdentity | null | undefined;
  readonly canEdit: boolean;
}) {
  const { environmentId, projectId, repositoryIdentity } = props;
  const client = useAtlassianClient(environmentId);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  // The reader's edits; null follows the saved link (or the defaults it seeds from).
  const [draft, setDraft] = useState<ProjectAtlassianLinkFields | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState<"saving" | "unlinking" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let current = true;
    Promise.all([client.listConnections(), client.getProjectLink({ projectId })]).then(
      ([connections, link]) => {
        if (current) setLoaded({ status: "ready", connections, link });
      },
      (reason: unknown) => {
        if (current) setLoaded({ status: "error", message: loadFailure(reason), attempt });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, client, projectId]);

  const jiraConnections =
    loaded.status === "ready" ? atlassianConnectionsFor(loaded.connections, "jira") : [];
  const bitbucketConnections =
    loaded.status === "ready" ? atlassianConnectionsFor(loaded.connections, "bitbucket") : [];
  const link = loaded.status === "ready" ? loaded.link : null;
  const fields =
    draft ??
    projectAtlassianLinkFields({ link, jiraConnections, bitbucketConnections, repositoryIdentity });
  const edit = (patch: Partial<ProjectAtlassianLinkFields>) => setDraft({ ...fields, ...patch });
  const disabled = !props.canEdit || !client || loaded.status !== "ready" || busy !== null;

  const chooseConnection = (
    title: string,
    connections: readonly AtlassianConnectionSummary[],
    selected: string,
    pick: (value: string) => void,
  ) => {
    Alert.alert(title, undefined, [
      ...[
        { value: ATLASSIAN_NONE_VALUE, label: "Not linked" },
        ...connections.map((connection) => ({
          value: connection.connectionId as string,
          label: connection.label,
        })),
      ].map((choice) => ({
        text: choice.value === selected ? `${choice.label} ✓` : choice.label,
        onPress: () => pick(choice.value),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  const write = (
    kind: "saving" | "unlinking",
    build: () => Parameters<AtlassianClient["saveProjectLink"]>[0],
  ) => {
    if (!client) return;
    setBusy(kind);
    setError(null);
    void runSettingsWrite({
      canEdit: props.canEdit,
      write: () =>
        client.saveProjectLink(build()).then((saved) => {
          setLoaded((current) =>
            current.status === "ready" ? { ...current, link: saved } : current,
          );
        }),
      fallback: "The project link was not saved.",
    }).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDraft(null);
    });
  };

  const save = () =>
    write("saving", () =>
      buildProjectAtlassianLinkSaveInput({ projectId, existing: link, fields }),
    );
  const unlink = () =>
    Alert.alert(
      "Unlink Jira?",
      "Work items stop attaching to this project. The Bitbucket mapping and templates stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: () =>
            write("unlinking", () => buildJiraProjectUnlinkInput({ projectId, existing: link })),
        },
      ],
    );

  if (!client || loaded.status === "loading") {
    return (
      <ProjectSettingsSection section="integrations">
        <SettingsRow first label="Jira & Bitbucket" value={client ? "Loading…" : "Offline"} />
      </ProjectSettingsSection>
    );
  }
  if (loaded.status === "error") {
    return (
      <ProjectSettingsSection section="integrations">
        <SettingsRow first label="Could not read the link" detail={loaded.message} />
        <SettingsRow
          label="Try again"
          onPress={() => {
            setLoaded({ status: "loading" });
            setAttempt(loaded.attempt + 1);
          }}
        />
      </ProjectSettingsSection>
    );
  }
  if (jiraConnections.length === 0 && bitbucketConnections.length === 0) {
    return (
      <ProjectSettingsSection
        section="integrations"
        footer="Connect Jira or Bitbucket in the desktop app's Settings → Source control, then link this project here."
      >
        <SettingsRow first label={`No Atlassian connection on ${props.machineLabel}`} />
      </ProjectSettingsSection>
    );
  }

  return (
    <ProjectSettingsSection
      section="integrations"
      footer="Which Jira projects and Bitbucket repository this project maps to. Credentials live in the desktop app's Settings."
    >
      <SettingsRow
        first
        label="Jira"
        value={atlassianConnectionLabel(fields.jiraConnectionValue, jiraConnections)}
        detail="Work items from these projects attach to worktrees and power smart links."
        disabled={disabled}
        onPress={() =>
          chooseConnection(
            "Jira connection",
            jiraConnections,
            fields.jiraConnectionValue,
            (value) => edit({ jiraConnectionValue: value }),
          )
        }
      />
      <FieldRow
        label="Jira project keys"
        value={fields.jiraProjectKeys}
        placeholder="WEB, API"
        disabled={disabled}
        mono
        autoCapitalize="characters"
        onChange={(value) => edit({ jiraProjectKeys: value })}
      />
      <SettingsRow
        label="Bitbucket"
        value={atlassianConnectionLabel(fields.bitbucketConnectionValue, bitbucketConnections)}
        detail="The workspace and repository pull requests and builds come from."
        disabled={disabled}
        onPress={() =>
          chooseConnection(
            "Bitbucket connection",
            bitbucketConnections,
            fields.bitbucketConnectionValue,
            (value) => edit({ bitbucketConnectionValue: value }),
          )
        }
      />
      <FieldRow
        label="Bitbucket workspace"
        value={fields.bitbucketWorkspace}
        placeholder="workspace"
        disabled={disabled}
        onChange={(value) => edit({ bitbucketWorkspace: value })}
      />
      <FieldRow
        label="Repository slug"
        value={fields.bitbucketRepoSlug}
        placeholder="repo-slug"
        disabled={disabled}
        onChange={(value) => edit({ bitbucketRepoSlug: value })}
      />
      <SettingsRow
        label={advancedOpen ? "Hide templates and links" : "Templates and links"}
        detail="Branch, commit and pull request names; smart links."
        onPress={() => setAdvancedOpen((open) => !open)}
      />
      {advancedOpen ? (
        <>
          <FieldRow
            label="Default issue type"
            value={fields.defaultIssueTypeName}
            placeholder="Task"
            disabled={disabled}
            onChange={(value) => edit({ defaultIssueTypeName: value })}
          />
          <FieldRow
            label="Branch name"
            value={fields.branchNameTemplate}
            disabled={disabled}
            mono
            onChange={(value) => edit({ branchNameTemplate: value })}
          />
          <FieldRow
            label="Commit message"
            value={fields.commitMessageTemplate}
            disabled={disabled}
            mono
            onChange={(value) => edit({ commitMessageTemplate: value })}
          />
          <FieldRow
            label="Pull request title"
            value={fields.pullRequestTitleTemplate}
            disabled={disabled}
            mono
            detail="Templates use {issueKey}, {summary} and {titleSlug}."
            onChange={(value) => edit({ pullRequestTitleTemplate: value })}
          />
          <SettingsSwitchRow
            label="Smart links"
            detail="Link Jira keys found in branches, commits and pull requests."
            value={fields.smartLinkingEnabled}
            disabled={disabled}
            onValueChange={(value) => edit({ smartLinkingEnabled: value })}
          />
          <SettingsSwitchRow
            label="Attach work items"
            detail="Attach linked work items to new worktrees and tasks."
            value={fields.autoAttachWorkItems}
            disabled={disabled}
            onValueChange={(value) => edit({ autoAttachWorkItems: value })}
          />
        </>
      ) : null}
      {error ? <SectionMessage tone="danger" message={error} /> : null}
      <View className="flex-row items-center gap-2 border-t border-border-subtle px-5 py-3">
        {isJiraLinked(link) ? (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={unlink}
            className="h-11 justify-center rounded-full px-3 active:bg-subtle disabled:opacity-40"
          >
            <Text className="text-sm font-ryco-bold text-danger-foreground">
              {busy === "unlinking" ? "Unlinking…" : "Unlink Jira"}
            </Text>
          </Pressable>
        ) : null}
        <View className="flex-1" />
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={save}
          className="h-11 justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
        >
          <Text className="text-sm font-ryco-bold text-primary-foreground">
            {busy === "saving" ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </ProjectSettingsSection>
  );
}

function FieldRow(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly detail?: string;
  readonly disabled: boolean;
  readonly mono?: boolean;
  readonly autoCapitalize?: "none" | "characters";
  readonly onChange: (value: string) => void;
}) {
  return (
    <View className="border-t border-border-subtle px-5 py-3">
      <Text className="font-sans text-[17px] text-foreground">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        value={props.value}
        placeholder={props.placeholder}
        editable={!props.disabled}
        autoCapitalize={props.autoCapitalize ?? "none"}
        autoCorrect={false}
        spellCheck={false}
        onChangeText={props.onChange}
        className={`mt-2 ${props.mono ? "font-mono text-sm" : ""}`}
      />
      {props.detail ? (
        <Text className="mt-1 font-sans text-xs leading-4 text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}
