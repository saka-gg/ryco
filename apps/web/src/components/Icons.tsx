/*
 * The icons live in per-family modules under `icons/`; this barrel keeps every
 * import path working. The bundler resolves each binding to its defining
 * module, so a surface carries only the families it renders (the hosted
 * sign-in needs one icon, not the editor logos) as long as this file holds
 * nothing but re-exports.
 */
export type { Icon } from "./icons/IconTypes";
export { GitHubIcon } from "./icons/GitHubIcon";
export {
  AtlassianJiraIcon,
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
  GitIcon,
  GitLabIcon,
  JiraIcon,
  JujutsuIcon,
} from "./icons/SourceControlIcons";
export {
  AntigravityIcon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "./icons/EditorIcons";
export {
  ACPRegistryIcon,
  ClaudeAI,
  CursorIcon,
  Gemini,
  GithubCopilotIcon,
  GrokIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "./icons/ProviderIcons";
