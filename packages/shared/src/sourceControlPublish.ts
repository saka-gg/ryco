import type {
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
} from "@ryco/contracts";
import * as Option from "effect/Option";

/**
 * Publishing a local repository to a host: which hosts can take one, whether
 * each is ready on the node, and what a valid target path looks like. Shared
 * by the desktop's publish dialog and the phone's publish sheet, so both read
 * the node's source-control discovery the same way.
 */

export type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
>;

export interface PublishProviderOption {
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
}

export const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
  },
  {
    value: "forgejo",
    label: "Forgejo",
    description: "Forgejo instance",
    host: "configured Forgejo host",
    pathPlaceholder: "owner/repo",
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
  },
] as const satisfies ReadonlyArray<PublishProviderOption>;

export function publishProviderOption(provider: PublishProviderKind): PublishProviderOption {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

export function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

export interface PublishProviderReadiness {
  readonly ready: boolean;
  readonly hint: string | null;
}

/** Whether the node can publish to `provider`: its CLI is installed and signed in. */
export function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): PublishProviderReadiness {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        `${discovered.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
    };
  }
  return { ready: true, hint: null };
}

/** The signed-in account per host, the prefix a new repository path starts from. */
export function publishAccountsByProvider(
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): Record<PublishProviderKind, string | null> {
  const accounts: Record<PublishProviderKind, string | null> = {
    github: null,
    gitlab: null,
    forgejo: null,
    bitbucket: null,
    "azure-devops": null,
  };
  for (const provider of sourceControlProviders) {
    if (isPublishProviderKind(provider.kind)) {
      accounts[provider.kind] = Option.getOrNull(provider.auth.account);
    }
  }
  return accounts;
}

/** An `owner/name` path (the name may hold further slashes, as GitLab groups do). */
export function isPublishRepositoryPathComplete(path: string): boolean {
  const [owner = "", ...rest] = path.trim().split("/");
  return owner.trim().length > 0 && rest.join("/").trim().length > 0;
}
