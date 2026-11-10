import type { EnvironmentId, TerminalRef, TerminalSubscribeEventsInput } from "@ryco/contracts";

import type { ClientVisibility } from "./clientVisibility.ts";
import {
  holdTerminalOutput,
  isTerminalOutputHeld,
  readTerminalOutputHolds,
  subscribeTerminalOutputReleases,
} from "./terminalOutputHolds.ts";

export interface TerminalOutputScopePorts {
  /** The environment this connection reaches; holds are kept per environment. */
  readonly environmentId: () => EnvironmentId | null;
  /** `terminal.detachOutput`; only called once the node acknowledged scoped output. */
  readonly detach: (ref: TerminalRef) => Promise<unknown>;
  /** `server.setConnectionVisibility`; only called once the node acknowledged scoped output. */
  readonly setVisibility: (visibility: ClientVisibility) => Promise<unknown>;
  readonly readVisibility: () => ClientVisibility;
}

/** Holds of a connection whose owner never named its environment (tests, ad hoc clients). */
const UNNAMED_ENVIRONMENT = "\u0000unnamed";
/** `TerminalSubscribeEventsInput.output.attached` holds at most this many. */
const MAX_ATTACHED_IN_SUBSCRIPTION = 64;
/**
 * Environments whose node acknowledged scoped output on some connection: output of terminals
 * nobody held may have stayed away, so a client buffer is no complete record of it. Sticky, so the
 * moment between a reconnect and the new stream's acknowledgement does not read as "unscoped".
 */
const scopedEnvironments = new Set<string>();

/**
 * One connection's view of the terminal output its client holds. Surfaces hold a terminal with
 * `attach` (counted per environment, see `terminalOutputHolds.ts`); `terminal.open` then asks the
 * node to attach the output before it takes its snapshot, and every (re)subscription of the event
 * stream names what is held, so a reconnect or a replacing connection needs nothing more. The
 * node answers a scoped subscription with `outputScope`; only then are detaches and visibility
 * hints sent, since older nodes do not know those methods (and send every terminal's output).
 */
export function createTerminalOutputScope(ports: TerminalOutputScopePorts) {
  let scoped = false;
  let sentVisibility: ClientVisibility = "foreground";
  /** Terminals released while no acknowledged stream could take the detach. */
  const pendingDetaches = new Map<string, TerminalRef>();
  const environment = () => ports.environmentId() ?? UNNAMED_ENVIRONMENT;

  const sendVisibility = (visibility: ClientVisibility) => {
    if (!scoped || visibility === sentVisibility) return;
    sentVisibility = visibility;
    void ports.setVisibility(visibility).catch(() => {
      // Best effort: the next acknowledgement or change sends it again.
      if (sentVisibility === visibility) sentVisibility = "foreground";
    });
  };

  const stopReleases = subscribeTerminalOutputReleases((environmentId, ref) => {
    if (environmentId !== environment()) return;
    if (scoped) void ports.detach(ref).catch(() => undefined);
    else pendingDetaches.set(JSON.stringify([ref.threadId, ref.terminalId]), ref);
  });

  return {
    attach(ref: TerminalRef): () => void {
      return holdTerminalOutput(environment(), ref);
    },
    isAttached(ref: TerminalRef): boolean {
      return isTerminalOutputHeld(environment(), ref);
    },
    /** The input of each (re)subscription: scoped, naming what is held right now. */
    subscribeInput(): TerminalSubscribeEventsInput {
      // A new stream may reach another node build; wait for its acknowledgement again.
      scoped = false;
      sentVisibility = "foreground";
      return {
        replay: "metadata",
        output: {
          attached: readTerminalOutputHolds(environment()).slice(0, MAX_ATTACHED_IN_SUBSCRIPTION),
        },
      };
    },
    /** The stream's `outputScope` item arrived: the node filters output for this connection. */
    acknowledge(): void {
      scoped = true;
      scopedEnvironments.add(environment());
      // Released before this node could hear it; held again since means attached again.
      for (const ref of pendingDetaches.values()) {
        if (!isTerminalOutputHeld(environment(), ref)) {
          void ports.detach(ref).catch(() => undefined);
        }
      }
      pendingDetaches.clear();
      sendVisibility(ports.readVisibility());
    },
    /** Whether this connection's current stream acknowledged scoped output. */
    isScoped(): boolean {
      return scoped;
    },
    /**
     * Whether output of terminals nobody held may have stayed away from this client: the node
     * acknowledged scoped output on this or an earlier connection (an older node sends all of it).
     */
    mayHaveFilteredOutput(): boolean {
      return scoped || scopedEnvironments.has(environment());
    },
    visibilityChanged(visibility: ClientVisibility): void {
      sendVisibility(visibility);
    },
    dispose(): void {
      stopReleases();
    },
  };
}

export type TerminalOutputScope = ReturnType<typeof createTerminalOutputScope>;
