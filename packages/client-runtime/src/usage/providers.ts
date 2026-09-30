import type { UsageProviderKind } from "@ryco/contracts";

export const USAGE_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const satisfies readonly UsageProviderKind[];
export const USAGE_PROVIDER_LABELS: Readonly<Record<UsageProviderKind, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};
export const USAGE_PROVIDER_COLORS: Readonly<Record<UsageProviderKind, string>> = {
  claude: "#d97757",
  codex: "#6b8cce",
  cursor: "#8b78bc",
  opencode: "#62a68a",
};
