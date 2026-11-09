import {
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  type Icon,
} from "../Icons";

export {
  formatRepositoryProviderLabel,
  resolveProjectRemoteLink,
  resolveRemoteUrlToBrowserUrl,
  type ProjectRemoteLink,
} from "@ryco/client-runtime/projectSettings/remotes";

export function resolveRepositoryProviderIcon(provider: string | undefined): Icon {
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
