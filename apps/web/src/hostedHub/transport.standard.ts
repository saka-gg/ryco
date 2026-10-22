import { hostedOnly } from "./hostedOnly";

/**
 * Standard-build stand-in for `./transport` (wired by `src/clientModeSeams.ts`).
 * A standard build opens no hosted relay attempts, so there is never a pending
 * relay request or a hosted dispatch lineage; the attempt entry points are
 * hosted-only. Signatures are pinned to the real module below.
 */
type Hosted = typeof import("./transport");

export const hasHostedRelayPendingRequests: Hosted["hasHostedRelayPendingRequests"] = () => false;

export const resetHostedRelayAttemptFactory: Hosted["resetHostedRelayAttemptFactory"] = () =>
  undefined;

export const hostedDispatchLineage: Hosted["hostedDispatchLineage"] = () => null;

export const bindHostedDispatchReplay: Hosted["bindHostedDispatchReplay"] = () =>
  hostedOnly("bindHostedDispatchReplay");

export const getHostedRelayAttemptFactory: Hosted["getHostedRelayAttemptFactory"] = () =>
  hostedOnly("getHostedRelayAttemptFactory");

export const createHostedEnvironmentAttemptFactory: Hosted["createHostedEnvironmentAttemptFactory"] =
  () => hostedOnly("createHostedEnvironmentAttemptFactory");

export const webHostedEnvironmentAttemptPorts: Hosted["webHostedEnvironmentAttemptPorts"] = () =>
  hostedOnly("webHostedEnvironmentAttemptPorts");

export const createWebHostedRelaySocket: Hosted["createWebHostedRelaySocket"] = () =>
  hostedOnly("createWebHostedRelaySocket");

export const createWebHostedServerAuthenticatedRelaySocket: Hosted["createWebHostedServerAuthenticatedRelaySocket"] =
  () => hostedOnly("createWebHostedServerAuthenticatedRelaySocket");

export const ticketFailure: Hosted["ticketFailure"] = () => hostedOnly("ticketFailure");

export const HostedRelayAttemptFactory = function HostedRelayAttemptFactory() {
  hostedOnly("HostedRelayAttemptFactory");
} as unknown as Hosted["HostedRelayAttemptFactory"];
