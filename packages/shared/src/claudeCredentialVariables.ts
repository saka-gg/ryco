/**
 * Claude Code's own credential and provider selection, checked against Claude Code 2.1.296. Each
 * of these makes it authenticate with something other than the local claude.ai login, or send
 * that login to another endpoint (a CLIProxyAPI hub sets `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN`). The node reads them in an instance's effective environment; a client
 * sees only the names an instance sets.
 *
 * @module claudeCredentialVariables
 */

/** Credentials Claude Code uses instead of the login, set to any non-empty value. */
export const CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
] as const;

/** Flags that route Claude Code to another provider, when set to a true value. */
export const CLAUDE_THIRD_PARTY_PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;
