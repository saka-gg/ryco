import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "@ryco/client-runtime/state/composer";
import { PROVIDER_SIGN_IN_FORBIDDEN } from "@ryco/client-runtime/state/providerSignIn";
import {
  canOfferProviderSignIn,
  claudeInstanceSkipsLogin,
  PROVIDER_SIGN_IN_DRIVERS,
  providerReportsSignIn,
} from "@ryco/shared/providerSignIn";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

import type { InboxEnvironment } from "../inbox/inboxModel";

export type ProviderAccountsEnvironment = Pick<
  InboxEnvironment,
  "environmentId" | "label" | "connectionState" | "role" | "mutationReady"
>;

/** Whether this session may sign providers in on a node, and why not. */
export interface ProviderSignInAccess {
  readonly allowed: boolean;
  readonly reason: string | null;
}

const ALLOWED: ProviderSignInAccess = { allowed: true, reason: null };

/**
 * The native capability of `provider.signIn.start` on one node. Hub roles follow the shared RPC
 * access policy; a direct session that is not the node's owner acts as a viewer. A node whose
 * role is not known yet is asked, and the controller reports a refusal. Mutations wait for a
 * live, mutation-ready session, as every other one does.
 */
export function providerSignInAccess(
  environment: ProviderAccountsEnvironment,
): ProviderSignInAccess {
  const role = environment.role;
  if (
    role === "client" ||
    (role !== undefined && !hostedRoleAllows(role, WS_METHODS.providerSignInStart))
  ) {
    return { allowed: false, reason: PROVIDER_SIGN_IN_FORBIDDEN };
  }
  if (environment.connectionState !== "connected" || environment.mutationReady !== true) {
    return { allowed: false, reason: `Available when ${environment.label} is connected` };
  }
  return ALLOWED;
}

export interface ProviderAccountRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** The account state, short enough for a row's value. */
  readonly status: string;
  readonly detail: string | undefined;
  /** Opens the sign-in sheet. */
  readonly canSignIn: boolean;
  readonly provider: ServerProvider;
  readonly instanceEnabled: boolean;
}

export interface ProviderAccountsNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly access: ProviderSignInAccess;
  /** `null` while the node has not sent its providers. */
  readonly rows: readonly ProviderAccountRow[] | null;
}

export interface ProviderAccountsView {
  readonly nodes: readonly ProviderAccountsNode[];
  /** Nodes that are not connected, which report no providers here. */
  readonly offline: readonly string[];
}

/** The row text of one instance: its account state first, then what can be done about it. */
function describeAccount(
  provider: ServerProvider,
  instance: ProviderInstanceConfig | undefined,
  nodeLabel: string,
  access: ProviderSignInAccess,
  canSignIn: boolean,
): { readonly status: string; readonly detail: string | undefined } {
  if (!provider.enabled || instance?.enabled === false) {
    return { status: "Disabled", detail: undefined };
  }
  if (provider.availability === "unavailable") {
    return { status: "Unavailable", detail: provider.unavailableReason };
  }
  if (!provider.installed) return { status: "Not installed", detail: undefined };
  if (provider.driver === "claudeAgent" && claudeInstanceSkipsLogin(instance)) {
    // A CLIProxyAPI hub or an API key: there is no login of this instance to show or start.
    return {
      status: "Own credentials",
      detail: "Signs in with credentials from its environment, such as a CLIProxyAPI hub.",
    };
  }
  if (providerReportsSignIn(provider)) return { status: "Signed in", detail: provider.auth.label };
  if (provider.status === "ready" && provider.auth.status === "unknown") {
    // Ready without an account it knows of, such as a Codex on a custom model provider.
    return { status: "Ready", detail: undefined };
  }
  // A check that could not tell, such as one whose CLI failed to run, knows of no account either
  // way. Otherwise there is none: "unauthenticated", or a Claude that started without an account.
  const unknown = provider.auth.status === "unknown";
  const status = unknown ? "Sign-in unknown" : "Not signed in";
  if (canSignIn) return { status, detail: "Tap to sign in." };
  if (PROVIDER_SIGN_IN_DRIVERS.has(provider.driver) && access.reason !== null) {
    return { status, detail: access.reason };
  }
  // The node's own word on what went wrong, rather than a login it never asked for.
  if (unknown && provider.message !== undefined) return { status, detail: provider.message };
  return { status, detail: `Sign in with its own CLI on ${nodeLabel}.` };
}

/**
 * Every connected node's provider instances with their account state, from the providers each
 * node reports (`ServerConfig.providers`, kept current by its config stream). An instance offers
 * a sign-in by the same rule the web's first-run setup uses (`canOfferProviderSignIn`), and only
 * where this session may start one.
 */
export function buildProviderAccounts(input: {
  readonly environments: readonly ProviderAccountsEnvironment[];
  readonly configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "providers" | "settings">>;
}): ProviderAccountsView {
  const nodes: ProviderAccountsNode[] = [];
  const offline: string[] = [];
  for (const environment of input.environments) {
    if (
      environment.connectionState !== "connected" &&
      environment.connectionState !== "read-only"
    ) {
      offline.push(environment.label);
      continue;
    }
    const access = providerSignInAccess(environment);
    const config = input.configs.get(environment.environmentId);
    if (config === undefined) {
      nodes.push({
        environmentId: environment.environmentId,
        label: environment.label,
        access,
        rows: null,
      });
      continue;
    }
    const instances = config.settings.providerInstances;
    const rows = sortProviderInstanceEntries(deriveProviderInstanceEntries(config.providers)).map(
      (entry): ProviderAccountRow => {
        const provider = entry.snapshot;
        const instance = instances?.[entry.instanceId];
        const canSignIn =
          instance?.enabled !== false &&
          canOfferProviderSignIn({ provider, instance, capabilityAllowed: access.allowed });
        const { status, detail } = describeAccount(
          provider,
          instance,
          environment.label,
          access,
          canSignIn,
        );
        return {
          key: `${environment.environmentId}\n${entry.instanceId}`,
          environmentId: environment.environmentId,
          instanceId: entry.instanceId,
          displayName: entry.displayName,
          status,
          detail,
          canSignIn,
          provider,
          instanceEnabled: provider.enabled && instance?.enabled !== false,
        };
      },
    );
    nodes.push({
      environmentId: environment.environmentId,
      label: environment.label,
      access,
      rows,
    });
  }
  return { nodes, offline };
}

/** The last `https:` address a terminal sign-in printed, for the page it asks to open. */
export function lastHttpsUrl(transcript: string): string | null {
  const matches = transcript.match(/https:\/\/[^\s"'<>`]+/gu);
  if (matches === null) return null;
  // Sentence punctuation after an address is not part of it.
  return matches.at(-1)!.replace(/[).,;:!?\]]+$/u, "");
}
