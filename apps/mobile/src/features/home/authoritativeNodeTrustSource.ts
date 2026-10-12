import type {
  NativeNodePairingProbe,
  NativeNodeTrustClassifier,
} from "./nativeNodeEligibilityModel";

export interface AuthoritativeNodeTrustSource {
  readonly hubOrigin: () => string | null;
  readonly classify: NativeNodeTrustClassifier;
  readonly pairing: NativeNodePairingProbe;
  /** Whether this environment's channel raised the §13.3 identity-change event. */
  readonly identityChanged: (environmentId: string) => boolean;
  /** Fires whenever an answer above may change: the trust document or a channel's session. */
  readonly subscribe: (listener: () => void) => () => void;
}

let source: AuthoritativeNodeTrustSource | null = null;
let sourceUnsubscribe: (() => void) | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function publish(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/**
 * Runtime-owned injection keeps native secure-store modules, and the E2EE session
 * with its curve and hash primitives, out of React imports and the launch graph.
 */
export function configureAuthoritativeNodeTrustSource(
  next: AuthoritativeNodeTrustSource | null,
): void {
  sourceUnsubscribe?.();
  source = next;
  sourceUnsubscribe = next?.subscribe(publish) ?? null;
  publish();
}

export function readAuthoritativeNodeTrustSource(): AuthoritativeNodeTrustSource | null {
  return source;
}

export function subscribeAuthoritativeNodeTrustSource(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function authoritativeNodeTrustSourceRevision(): number {
  return revision;
}
