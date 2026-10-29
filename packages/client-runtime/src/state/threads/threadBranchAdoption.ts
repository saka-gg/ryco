import type { ServerConfig } from "@ryco/contracts";

/**
 * Whether the node records a checkout's branch changes into its threads and
 * workspaces itself (`threadBranchAdoption`, read from its live server config).
 * Clients then record only the branches a user picks or a git action creates.
 * False for an older node, which leaves following the checkout to the client
 * showing the thread, and while the config has not arrived (a client that
 * follows the checkout waits for the config before writing anything).
 */
export function selectNodeRecordsThreadBranch(config: ServerConfig | null | undefined): boolean {
  return config?.environment.capabilities.threadBranchAdoption === true;
}
