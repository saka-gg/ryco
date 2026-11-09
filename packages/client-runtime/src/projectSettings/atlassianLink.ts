/**
 * A project's Jira and Bitbucket link as an editable form: seeded from the
 * saved link (or the first connection and the repository's own names) and
 * saved or unlinked as one `atlassian.saveProjectLink`. The web projects page,
 * its work-items tab and the phone's project settings share every rule here.
 */
import type {
  AtlassianConnectionId,
  AtlassianConnectionSummary,
  AtlassianProjectLink,
  AtlassianSaveProjectLinkInput,
  ProjectId,
  RepositoryIdentity,
} from "@ryco/contracts";

export const ATLASSIAN_DEFAULT_BRANCH_TEMPLATE = "{issueKey}-{titleSlug}";
/** The commit message and pull request title a new link starts with. */
export const ATLASSIAN_DEFAULT_SUMMARY_TEMPLATE = "{issueKey}: {summary}";
const DEFAULT_BRANCH_TEMPLATE = ATLASSIAN_DEFAULT_BRANCH_TEMPLATE;
const DEFAULT_COMMIT_TEMPLATE = ATLASSIAN_DEFAULT_SUMMARY_TEMPLATE;

/** The select value for "no connection". */
export const ATLASSIAN_NONE_VALUE = "Not configured";

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

/** The connected connections that serve one product, in the node's order. */
export function atlassianConnectionsFor(
  connections: ReadonlyArray<AtlassianConnectionSummary> | null | undefined,
  product: "jira" | "bitbucket",
): AtlassianConnectionSummary[] {
  return (connections ?? []).filter(
    (connection) => connection.status === "connected" && connection.products.includes(product),
  );
}

/** Every field of the link form, as text and switches. */
export interface ProjectAtlassianLinkFields {
  readonly jiraConnectionValue: string;
  readonly bitbucketConnectionValue: string;
  readonly jiraProjectKeys: string;
  readonly bitbucketWorkspace: string;
  readonly bitbucketRepoSlug: string;
  readonly defaultIssueTypeName: string;
  readonly branchNameTemplate: string;
  readonly commitMessageTemplate: string;
  readonly pullRequestTitleTemplate: string;
  readonly smartLinkingEnabled: boolean;
  readonly autoAttachWorkItems: boolean;
}

/**
 * The form as the saved link has it; without one, the first connection of each
 * product and the repository's own Bitbucket names, with the default templates.
 */
export function projectAtlassianLinkFields(input: {
  readonly link: AtlassianProjectLink | null | undefined;
  readonly jiraConnections: ReadonlyArray<AtlassianConnectionSummary>;
  readonly bitbucketConnections: ReadonlyArray<AtlassianConnectionSummary>;
  readonly repositoryIdentity: RepositoryIdentity | null | undefined;
}): ProjectAtlassianLinkFields {
  const { link } = input;
  const remote = bitbucketRemoteSuggestion(input.repositoryIdentity);
  return {
    jiraConnectionValue: atlassianConnectionValue(
      link?.jiraConnectionId ?? input.jiraConnections[0]?.connectionId,
    ),
    bitbucketConnectionValue: atlassianConnectionValue(
      link?.bitbucketConnectionId ?? input.bitbucketConnections[0]?.connectionId,
    ),
    jiraProjectKeys: link?.jiraProjectKeys.join(", ") ?? "",
    bitbucketWorkspace: link?.bitbucketWorkspace ?? remote.workspace,
    bitbucketRepoSlug: link?.bitbucketRepoSlug ?? remote.repoSlug,
    defaultIssueTypeName: link?.defaultIssueTypeName ?? "",
    branchNameTemplate: link?.branchNameTemplate ?? DEFAULT_BRANCH_TEMPLATE,
    commitMessageTemplate: link?.commitMessageTemplate ?? DEFAULT_COMMIT_TEMPLATE,
    pullRequestTitleTemplate: link?.pullRequestTitleTemplate ?? DEFAULT_COMMIT_TEMPLATE,
    smartLinkingEnabled: link?.smartLinkingEnabled ?? true,
    autoAttachWorkItems: link?.autoAttachWorkItems ?? true,
  };
}

/**
 * The save the form makes. Throws when a template is empty: the node needs all
 * three, and an empty one is never guessed back to its default.
 */
export function buildProjectAtlassianLinkSaveInput(input: {
  readonly projectId: ProjectId;
  readonly existing: AtlassianProjectLink | null | undefined;
  readonly fields: ProjectAtlassianLinkFields;
}): AtlassianSaveProjectLinkInput {
  const { fields } = input;
  const branchTemplate = fields.branchNameTemplate.trim();
  const commitTemplate = fields.commitMessageTemplate.trim();
  const prTemplate = fields.pullRequestTitleTemplate.trim();
  if (!branchTemplate || !commitTemplate || !prTemplate) {
    throw new Error("Branch, commit, and pull request templates cannot be empty.");
  }
  return {
    projectId: input.projectId,
    jiraConnectionId: nullableAtlassianConnectionId(fields.jiraConnectionValue),
    bitbucketConnectionId: nullableAtlassianConnectionId(fields.bitbucketConnectionValue),
    jiraCloudId: input.existing?.jiraCloudId ?? null,
    jiraSiteUrl: null,
    jiraProjectKeys: splitAtlassianProjectKeys(fields.jiraProjectKeys),
    bitbucketWorkspace: fields.bitbucketWorkspace.trim() || null,
    bitbucketRepoSlug: fields.bitbucketRepoSlug.trim() || null,
    defaultIssueTypeName: fields.defaultIssueTypeName.trim() || null,
    branchNameTemplate: branchTemplate,
    commitMessageTemplate: commitTemplate,
    pullRequestTitleTemplate: prTemplate,
    smartLinkingEnabled: fields.smartLinkingEnabled,
    autoAttachWorkItems: fields.autoAttachWorkItems,
  };
}

/** The saved link maps a Jira connection and at least one project key. */
export function isJiraLinked(link: AtlassianProjectLink | null | undefined): boolean {
  return (
    link?.jiraConnectionId !== null &&
    link?.jiraConnectionId !== undefined &&
    link.jiraProjectKeys.length > 0
  );
}

export function buildJiraProjectLinkInput(input: {
  readonly projectId: ProjectId;
  readonly existing: AtlassianProjectLink | null | undefined;
  readonly jiraConnectionId: AtlassianConnectionId | null;
  readonly jiraSiteUrl: string | null;
  readonly jiraProjectKeys: ReadonlyArray<string>;
}): AtlassianSaveProjectLinkInput {
  return {
    projectId: input.projectId,
    jiraConnectionId: input.jiraConnectionId,
    bitbucketConnectionId: input.existing?.bitbucketConnectionId ?? null,
    jiraCloudId: input.existing?.jiraCloudId ?? null,
    jiraSiteUrl: input.jiraSiteUrl,
    jiraProjectKeys: [...input.jiraProjectKeys],
    bitbucketWorkspace: input.existing?.bitbucketWorkspace ?? null,
    bitbucketRepoSlug: input.existing?.bitbucketRepoSlug ?? null,
    defaultIssueTypeName: input.existing?.defaultIssueTypeName ?? null,
    branchNameTemplate: input.existing?.branchNameTemplate ?? DEFAULT_BRANCH_TEMPLATE,
    commitMessageTemplate: input.existing?.commitMessageTemplate ?? DEFAULT_COMMIT_TEMPLATE,
    pullRequestTitleTemplate: input.existing?.pullRequestTitleTemplate ?? DEFAULT_COMMIT_TEMPLATE,
    smartLinkingEnabled: input.existing?.smartLinkingEnabled ?? true,
    autoAttachWorkItems: input.existing?.autoAttachWorkItems ?? true,
  };
}

export function buildJiraProjectUnlinkInput(input: {
  readonly projectId: ProjectId;
  readonly existing: AtlassianProjectLink | null | undefined;
}): AtlassianSaveProjectLinkInput {
  return {
    ...buildJiraProjectLinkInput({
      projectId: input.projectId,
      existing: input.existing,
      jiraConnectionId: null,
      jiraSiteUrl: null,
      jiraProjectKeys: [],
    }),
    jiraCloudId: null,
  };
}
