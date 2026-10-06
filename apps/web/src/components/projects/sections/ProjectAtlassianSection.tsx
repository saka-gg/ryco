import { ChevronRightIcon, LinkIcon } from "lucide-react";
import { useState } from "react";

import {
  DISCLOSURE_INNER_CLASS,
  disclosureChevronClassName,
  disclosureShellClassName,
} from "../../../lib/disclosureMotion";
import { cn } from "../../../lib/utils";
import { useSettingsDialogStore } from "../../../settingsDialogStore";
import { JiraProjectPicker } from "../../atlassian/JiraProjectPicker";
import {
  ATLASSIAN_NONE_VALUE,
  useProjectAtlassianLinkForm,
} from "../../atlassian/useProjectAtlassianLinkForm";
import { SettingsSelect } from "../../settings/SettingsSelect";
import {
  SETTINGS_INSET_CLASS,
  SettingsBlock,
  SettingsEmpty,
  SettingsField,
  SettingsRow,
} from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/**
 * Which Jira project and Bitbucket repository this project maps to, and the
 * templates and smart links built from them. Credentials live in Settings →
 * Source control; only this project's mapping is edited here. Owner-only: the
 * page leaves this section out (and says why once) for anyone else. The
 * templates and link switches fold away; most projects never change them.
 */
export function ProjectAtlassianSection({ member, canEdit }: ProjectSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const form = useProjectAtlassianLinkForm({
    environmentId: member.environmentId,
    projectId: member.id,
    repositoryIdentity: member.repositoryIdentity,
  });
  const { fields, setters } = form;
  const disabled = !canEdit || form.disabled;
  const openSourceControl = () =>
    useSettingsDialogStore.getState().openSettings("source-control", member.environmentId);

  const connectionOptions = (connections: typeof form.jiraConnections) => [
    { value: ATLASSIAN_NONE_VALUE, label: "Not linked" },
    ...connections.map((connection) => ({
      value: connection.connectionId as string,
      label: connection.label,
    })),
  ];

  return (
    <ProjectSection
      section="integrations"
      description="Which Jira projects and Bitbucket repository this project maps to. Credentials live in Settings → Source control."
    >
      {!form.isLoading && !form.hasConnections ? (
        <SettingsEmpty
          icon={<LinkIcon />}
          title="No Atlassian connection on this device"
          description="Connect Jira or Bitbucket in Settings, then link this project here."
          action={
            <Button size="sm" variant="outline" onClick={openSourceControl}>
              Open source control settings
            </Button>
          }
        />
      ) : (
        <>
          <SettingsRow
            title="Jira"
            description="Work items from these projects attach to worktrees and power smart links."
            control={
              <SettingsSelect
                ariaLabel="Jira connection"
                value={fields.jiraConnectionValue}
                options={connectionOptions(form.jiraConnections)}
                disabled={disabled}
                onValueChange={setters.setJiraConnectionValue}
              />
            }
          >
            <div className="flex min-w-0 flex-col gap-2 @[36rem]/detail:flex-row @[36rem]/detail:items-center">
              <JiraProjectPicker
                environmentId={member.environmentId}
                connectionId={form.selectedJiraConnectionId}
                siteUrl={form.selectedJiraSiteUrl}
                projectKeys={fields.jiraProjectKeys}
                disabled={disabled}
                onProjectKeysChange={setters.setJiraProjectKeys}
              />
              <Input
                size="sm"
                aria-label="Jira project keys"
                value={fields.jiraProjectKeys}
                disabled={disabled}
                placeholder="WEB, API"
                className="min-w-0 flex-1 font-mono text-xs"
                onChange={(event) => setters.setJiraProjectKeys(event.currentTarget.value)}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title="Bitbucket"
            description="The workspace and repository pull requests and builds come from."
            control={
              <SettingsSelect
                ariaLabel="Bitbucket connection"
                value={fields.bitbucketConnectionValue}
                options={connectionOptions(form.bitbucketConnections)}
                disabled={disabled}
                onValueChange={setters.setBitbucketConnectionValue}
              />
            }
          >
            <div className="grid min-w-0 gap-2 @[36rem]/detail:grid-cols-2">
              <Input
                size="sm"
                aria-label="Bitbucket workspace"
                value={fields.bitbucketWorkspace}
                disabled={disabled}
                placeholder="workspace"
                onChange={(event) => setters.setBitbucketWorkspace(event.currentTarget.value)}
              />
              <Input
                size="sm"
                aria-label="Bitbucket repository slug"
                value={fields.bitbucketRepoSlug}
                disabled={disabled}
                placeholder="repo-slug"
                onChange={(event) => setters.setBitbucketRepoSlug(event.currentTarget.value)}
              />
            </div>
          </SettingsRow>
          <SettingsBlock flush>
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
              className={cn(
                "flex w-full items-center gap-1.5 py-3 text-left text-[13px] font-medium outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/40 focus-visible:bg-accent/55",
                SETTINGS_INSET_CLASS,
              )}
            >
              <ChevronRightIcon
                className={disclosureChevronClassName(advancedOpen, "text-muted-foreground")}
              />
              Templates and links
              <span className="ml-auto hidden min-w-0 truncate text-xs font-normal text-muted-foreground @[40rem]/detail:inline">
                Branch, commit and pull request names; smart links
              </span>
            </button>
            <div className={disclosureShellClassName(advancedOpen)}>
              <div className={DISCLOSURE_INNER_CLASS}>
                <div className="border-t border-border/60" inert={!advancedOpen}>
                  <SettingsBlock>
                    <div className="grid min-w-0 gap-3 @[36rem]/detail:grid-cols-2">
                      <SettingsField
                        label="Default issue type"
                        htmlFor="project-atlassian-issue-type"
                      >
                        <Input
                          id="project-atlassian-issue-type"
                          size="sm"
                          value={fields.defaultIssueTypeName}
                          disabled={disabled}
                          placeholder="Task"
                          onChange={(event) =>
                            setters.setDefaultIssueTypeName(event.currentTarget.value)
                          }
                        />
                      </SettingsField>
                      <SettingsField label="Branch name" htmlFor="project-atlassian-branch">
                        <Input
                          id="project-atlassian-branch"
                          size="sm"
                          value={fields.branchNameTemplate}
                          disabled={disabled}
                          className="font-mono text-xs"
                          onChange={(event) =>
                            setters.setBranchNameTemplate(event.currentTarget.value)
                          }
                        />
                      </SettingsField>
                      <SettingsField label="Commit message" htmlFor="project-atlassian-commit">
                        <Input
                          id="project-atlassian-commit"
                          size="sm"
                          value={fields.commitMessageTemplate}
                          disabled={disabled}
                          className="font-mono text-xs"
                          onChange={(event) =>
                            setters.setCommitMessageTemplate(event.currentTarget.value)
                          }
                        />
                      </SettingsField>
                      <SettingsField
                        label="Pull request title"
                        htmlFor="project-atlassian-pr-title"
                      >
                        <Input
                          id="project-atlassian-pr-title"
                          size="sm"
                          value={fields.pullRequestTitleTemplate}
                          disabled={disabled}
                          className="font-mono text-xs"
                          onChange={(event) =>
                            setters.setPullRequestTitleTemplate(event.currentTarget.value)
                          }
                        />
                      </SettingsField>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Templates use <code className="font-mono">{"{issueKey}"}</code>,{" "}
                      <code className="font-mono">{"{summary}"}</code> and{" "}
                      <code className="font-mono">{"{titleSlug}"}</code>.
                    </p>
                  </SettingsBlock>
                  <SettingsRow
                    title="Smart links"
                    description="Link Jira keys found in branches, commits and pull requests."
                    control={
                      <Switch
                        aria-label="Smart links"
                        checked={fields.smartLinkingEnabled}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setters.setSmartLinkingEnabled(Boolean(checked))
                        }
                      />
                    }
                  />
                  <SettingsRow
                    title="Attach work items"
                    description="Attach linked work items to new worktrees and threads."
                    control={
                      <Switch
                        aria-label="Attach work items"
                        checked={fields.autoAttachWorkItems}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setters.setAutoAttachWorkItems(Boolean(checked))
                        }
                      />
                    }
                  />
                </div>
              </div>
            </div>
          </SettingsBlock>
          <SettingsBlock className="flex items-center justify-end gap-2">
            {form.jiraLinked ? (
              <Button
                size="sm"
                variant="ghost"
                className="mr-auto text-destructive-foreground"
                disabled={disabled}
                onClick={form.unlinkJira}
              >
                {form.unlinking ? "Unlinking…" : "Unlink Jira"}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={disabled} onClick={form.save}>
              {form.saving ? "Saving…" : "Save"}
            </Button>
          </SettingsBlock>
        </>
      )}
    </ProjectSection>
  );
}
