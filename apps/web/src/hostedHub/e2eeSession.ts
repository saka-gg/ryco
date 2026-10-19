import type { EnvironmentId } from "@ryco/contracts";

import type { WebHostedE2eeChannelStatus } from "./connectionStatus";

// The PER-CHANNEL §4.4 projection for this tier, and nothing else.
//
// It holds two values per environment: the channel state the §4.4 machine
// locked, and §13.5's rendered `WebSAS` for the session that locked it. Both are
// ephemeral by §13.5's own rule — "forbids logging, persisting, or sending it to
// analytics" — so this module keeps them in module scope, hands them out only
// through a snapshot, and drops them the moment the channel that earned them
// stops being current.
//
// EVERY ENVIRONMENT HAS ITS OWN ENTRY, and surfaces read the DISPLAYED one. The
// hosted client can hold channels to several nodes at once, and a single shared
// projection let whichever channel negotiated last own the status — so the
// `WebSAS` drawn for the selected node could belong to another node's session,
// which breaks §13.5's one property: the owner compares the code against the
// node CLI of the session that produced it. An entry is written only by the
// channel that owns it, and the displayed environment follows the selection.
//
// IT SHIPS NO COPY. The status word, the §13.5 disclosure, and every other
// user-facing string belong to the surface that renders them; §2.2 and §2.3
// forbid this tier from claiming operator-proof protection, and a claim is made
// in words, not in a union member. `web-unsigned` is §2.2's own row name and is
// the strongest state this module can ever hold — `verified` and `unverified`
// are not in `WebHostedE2eeChannelStatus` at all (see `connectionStatus.ts`), so
// the native rows are unrepresentable here rather than merely unused.

export interface WebE2eeSessionState {
  /** §4.4's channel state, narrowed to the states a web client can be in. */
  readonly status: WebHostedE2eeChannelStatus;
  /**
   * §13.5's rendered code for the CURRENT `e2ee` session, or `null`.
   *
   * It is the display string and never key material: §13.5 derives it inside the
   * shared handshake from this client's Noise ephemeral and the §8.8
   * `sessionBindingHash`, neither of which leaves that module.
   */
  readonly verificationCode: string | null;
}

const UNAVAILABLE: WebE2eeSessionState = Object.freeze({
  status: "unavailable",
  verificationCode: null,
});

/**
 * One environment's projection, and the channel that earned it.
 *
 * `channel` is an identity and nothing else. A stale channel MUST NOT clear or
 * overwrite a live channel's entry: the engine ends a channel from `#finish`,
 * and nothing orders that against the successor socket's `channel.accept`, so a
 * reconnect can begin the next channel before the previous one finishes tearing
 * down. Every write that names a channel applies only while that channel owns
 * the entry. `null` is an entry written without one, which only the
 * channel-less forms below produce.
 */
interface WebE2eeChannelEntry {
  readonly channel: object | null;
  readonly state: WebE2eeSessionState;
}

/**
 * The entry a call addresses: an environment's own, or `null` for the single
 * unscoped slot a call without an environment addresses while no environment is
 * displayed.
 */
type WebE2eeSlot = EnvironmentId | null;

const entries = new Map<WebE2eeSlot, WebE2eeChannelEntry>();
let displayedEnvironment: EnvironmentId | null = null;
const listeners = new Set<() => void>();
const environmentListeners = new Map<EnvironmentId, Set<() => void>>();

/** §11.4's bounded, application-session-local web diagnostic set. */
export type WebE2eeLocalDiagnosticId = "e2ee_policy_generation_regressed";

let diagnostics: readonly WebE2eeLocalDiagnosticId[] = [];
const DIAGNOSTICS_MAX = 8;

function slotFor(environmentId: EnvironmentId | undefined): WebE2eeSlot {
  return environmentId ?? displayedEnvironment;
}

function notifyDisplayed(): void {
  for (const listener of listeners) listener();
}

function notifySlot(slot: WebE2eeSlot): void {
  if (slot === displayedEnvironment) notifyDisplayed();
  if (slot === null) return;
  const environment = environmentListeners.get(slot);
  if (environment === undefined) return;
  for (const listener of environment) listener();
}

function write(slot: WebE2eeSlot, channel: object | null, next: WebE2eeSessionState): void {
  const current = entries.get(slot);
  const unchanged =
    current !== undefined &&
    current.state.status === next.status &&
    current.state.verificationCode === next.verificationCode;
  entries.set(slot, { channel, state: unchanged ? current.state : next });
  if (!unchanged) notifySlot(slot);
}

function remove(slot: WebE2eeSlot): void {
  if (entries.delete(slot)) notifySlot(slot);
}

/**
 * The displayed environment's projection, `unavailable` when it has none. A
 * stable snapshot, safe to pass to `useSyncExternalStore`.
 */
export function webE2eeSessionState(): WebE2eeSessionState {
  return entries.get(displayedEnvironment)?.state ?? UNAVAILABLE;
}

/** One environment's projection, displayed or not. A stable snapshot as above. */
export function webE2eeSessionStateFor(environmentId: EnvironmentId): WebE2eeSessionState {
  return entries.get(environmentId)?.state ?? UNAVAILABLE;
}

/**
 * Notified when the displayed projection changes — its own entry, or which
 * environment is displayed — and on diagnostics. Another environment's channel
 * does not notify it.
 */
export function subscribeWebE2eeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Notified when one environment's entry changes, whether or not it is displayed. */
export function subscribeWebE2eeSessionFor(
  environmentId: EnvironmentId,
  listener: () => void,
): () => void {
  let environment = environmentListeners.get(environmentId);
  if (environment === undefined) {
    environment = new Set();
    environmentListeners.set(environmentId, environment);
  }
  const subscribed = environment;
  subscribed.add(listener);
  return () => {
    subscribed.delete(listener);
    if (subscribed.size === 0 && environmentListeners.get(environmentId) === subscribed) {
      environmentListeners.delete(environmentId);
    }
  };
}

/**
 * The environment whose projection the session-wide surfaces show: the selected
 * node's, or none. Switching it never moves an entry — each channel's state
 * stays with the environment that earned it — so a switch shows the newly
 * selected environment's own state, `unavailable` until its channel begins.
 */
export function setDisplayedWebE2eeEnvironment(environmentId: EnvironmentId | null): void {
  if (environmentId === displayedEnvironment) return;
  const previous = webE2eeSessionState();
  displayedEnvironment = environmentId;
  if (webE2eeSessionState() !== previous) notifyDisplayed();
}

/** Stable local-only diagnostics; never serialized or placed on the wire. */
export function webE2eeLocalDiagnostics(): readonly WebE2eeLocalDiagnosticId[] {
  return diagnostics;
}

/** §5.7's named rollback diagnostic, kept across channel reconnects. */
export function recordWebE2eePolicyGenerationRegression(): void {
  const next: readonly WebE2eeLocalDiagnosticId[] = [
    ...diagnostics,
    "e2ee_policy_generation_regressed",
  ];
  diagnostics = next.slice(-DIAGNOSTICS_MAX);
  notifyDisplayed();
}

/** End the diagnostic's application-session lifetime. Called on sign-out. */
export function clearWebE2eeLocalDiagnostics(): void {
  if (diagnostics.length === 0) return;
  diagnostics = [];
  notifyDisplayed();
}

/**
 * A new channel is negotiating (§4.4), which claims nothing.
 *
 * §13 projection is PER CHANNEL and not per selection: a state earned by one
 * channel may not describe the next one, and the §13.5 code is bound to a single
 * session by construction. Publishing `negotiating` here is what keeps either
 * from surviving the socket that produced it.
 *
 * With a `channel`, that channel takes the environment's entry over: one channel
 * is current per environment, and the one beginning is it. Without an
 * environment, the displayed entry is addressed.
 */
export function beginWebE2eeChannelAttempt(environmentId?: EnvironmentId, channel?: object): void {
  write(slotFor(environmentId), channel ?? null, {
    status: "negotiating",
    verificationCode: null,
  });
}

/**
 * §4.4's single mode lock, projected.
 *
 * `e2ee` becomes `web-unsigned` — §2.2's *Web, unsigned ephemeral* row — and
 * never `verified`: the Hub serves this client's JavaScript (§2.4), so a locked
 * NX channel is not the native guarantee and must not be reported as one.
 *
 * With a `channel`, it applies only while that channel owns the entry.
 */
export function lockWebE2eeChannelMode(
  mode: "e2ee" | "legacy",
  environmentId?: EnvironmentId,
  channel?: object,
): void {
  const slot = slotFor(environmentId);
  const current = entries.get(slot);
  if (channel !== undefined && current?.channel !== channel) return;
  write(slot, current?.channel ?? null, {
    status: mode === "e2ee" ? "web-unsigned" : "legacy",
    verificationCode: mode === "e2ee" ? (current?.state.verificationCode ?? null) : null,
  });
}

/**
 * §13.5's code, published by the §4.4 machine after ITS OWN `e2ee` lock.
 *
 * THE ORDERING IS THE SUBTLE PART, and gating this on `web-unsigned` silently
 * threw the code away. §4.4's mode lock is a state the machine holds rather than
 * a callback, so the machine locks, derives, and publishes here — and only then
 * does the caller's post-operation sync tell this module the mode changed. The
 * live state at this instant is therefore still `negotiating`.
 *
 * `unavailable` and `legacy` are refused because neither can ever have a code:
 * one has no channel and the other locked plaintext, so a value arriving in
 * either describes a session that does not exist. With a `channel`, a code from
 * any channel but the entry's owner is refused for the same reason.
 */
export function publishWebE2eeVerificationCode(
  code: string,
  environmentId?: EnvironmentId,
  channel?: object,
): void {
  const slot = slotFor(environmentId);
  const current = entries.get(slot);
  if (current === undefined) return;
  if (channel !== undefined && current.channel !== channel) return;
  const { status } = current.state;
  if (status === "unavailable" || status === "legacy") return;
  write(slot, current.channel, { status, verificationCode: code });
}

/**
 * Drop the projection. Called when a channel, an environment or the session
 * ends — a standing `web-unsigned` would otherwise describe a channel that no
 * longer exists, for a node the owner has left, or for an account that has
 * signed out.
 *
 * With no arguments the whole projection goes, every environment's entry with
 * it: the application session ended. With an environment, only its entry goes;
 * with a `channel` as well, only while that channel still owns it.
 */
export function resetWebE2eeSession(environmentId?: EnvironmentId, channel?: object): void {
  if (environmentId === undefined && channel === undefined) {
    const slots = [...entries.keys()];
    entries.clear();
    for (const slot of slots) notifySlot(slot);
    return;
  }
  const slot = slotFor(environmentId);
  if (channel !== undefined && entries.get(slot)?.channel !== channel) return;
  remove(slot);
}
