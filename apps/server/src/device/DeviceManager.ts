/**
 * DeviceManager - thread-scoped device attachment and boot ownership.
 *
 * State the manager owns, and why it owns it rather than the backend:
 *
 * - Attachment is per thread (one device per thread, mirroring
 *   `ThreadBrowserState`). A thread's `ThreadDeviceState` is versioned and
 *   pushed on `device.event` so panes can drop stale snapshots.
 * - Boot source. The backend cannot tell who booted a device, so the manager
 *   records the devices it booted itself. Only those are ever auto-shut-down;
 *   anything the user started (pane picker, Simulator.app) outlives us.
 * - The Ryco boot cap (`DEVICE_RYCO_BOOT_LIMIT`). Boot past the cap is
 *   refusable rather than fatal: the caller is handed the shutdown candidates
 *   so the pane can prompt.
 * - Shutdown triggers: app quit (`dispose`), switching a thread away from an
 *   otherwise unused device, and an idle grace once a Ryco-owned device's last
 *   consumer settles. Consumers are a boot in flight, a recording, an in-flight
 *   manager call (pane RPC, agent tool, Agent Control action), a frame viewer,
 *   a thread a person attached, and an agent's hold for the provider turn that
 *   is still its thread's running turn. Agent attachments are metadata and
 *   never keep a device up; thread removal (`handleThreadRemoved`) ends the
 *   thread's attachment and holds. Only Ryco-owned boots are ever shut down.
 *
 * Everything the manager does to the device itself goes through DeviceBackend,
 * so the whole state machine is testable against `FakeDeviceBackend`.
 *
 * @module device/DeviceManager
 */
import { NULL_BOOT_OWNERSHIP, processIsAlive, type BootOwnershipStore } from "./bootOwnership.ts";
import {
  DEVICE_RYCO_BOOT_LIMIT,
  ThreadId,
  type DeviceAttachPhase,
  type DeviceAvailability,
  type DeviceBootResult,
  type DeviceDescribeUiResult,
  type DeviceDescriptor,
  type DeviceEvent,
  type DeviceHardwareButton,
  type DeviceInstallAppResult,
  type DeviceLaunchAppResult,
  type DeviceListResult,
  type DeviceOpenPaneReason,
  type DeviceTestingInput,
  type DeviceScreenshotResult,
  type DeviceStartRecordingResult,
  type DeviceStopRecordingResult,
  type DeviceUiNode,
  type ThreadDeviceState,
} from "@ryco/contracts";

import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceDiscovery,
  type DeviceKeyEvent,
  type DeviceLogQuery,
  type DeviceLogResult,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";
import {
  DeviceUiTargetError,
  SCROLL_SWIPE_DURATION_MS,
  findTarget,
  planScrollStep,
  visibleLabels,
  type DeviceUiTarget,
  type DeviceUiTargetMatch,
} from "./uiTreeTargeting.ts";

/**
 * How long a Ryco-booted device stays up after its last consumer settles: no
 * boot, recording, in-flight call, viewer, user attachment or running agent
 * turn holding it. Agent attachments do not count. User-booted devices never
 * get this grace.
 */
export const DEVICE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
/**
 * How long an agent's request to open the device pane waits for a client to
 * hear it. Clients stream device events only while a surface that can show the
 * pane is mounted, so a request made while no client streams is held for the
 * next client stream instead of being lost.
 */
export const DEVICE_OPEN_PANE_REQUEST_HOLD_MS = 10 * 60 * 1000;

/**
 * How long to keep retrying a stream attach that keeps failing transiently.
 *
 * A simulator reports itself booted before CoreSimulator publishes its display,
 * so the first attach after a cold boot reliably fails with "no framebuffer
 * surface yet". On a warm machine the window is a second or two; on a cold one,
 * with the first launch of a new runtime, it has been seen past twenty. Sixty
 * seconds covers the bad case and still fails while the user is watching rather
 * than leaving them staring at a spinner forever.
 */
export const DEVICE_ATTACH_DEADLINE_MS = 60_000;

/** Gap between attach retries. Short enough to feel immediate once ready. */
export const DEVICE_ATTACH_RETRY_MS = 750;

/**
 * What to tell the user when the display never appeared.
 *
 * Names the one action that actually fixes it. Retrying the attach is what just
 * failed for a minute, so the message does not suggest it.
 */
const DISPLAY_TIMEOUT_MESSAGE =
  "The simulator booted but never published a screen to capture. Shut it down and start it again; " +
  "if that keeps happening, the runtime may need reinstalling from Xcode's Platforms settings.";

/**
 * Failures worth waiting out rather than latching.
 *
 * All of these mean "not ready yet" rather than "will never work": the display
 * has not been published, the device is mid-boot, or the helper's descriptor
 * belongs to a boot that is being replaced. A refusal that is not one of these
 * (no such device, a broken capability, a helper that will not compile) is
 * reported immediately, because retrying it for a minute only delays the truth.
 */
export function isTransientAttachFailure(error: unknown): boolean {
  if (error instanceof DeviceBackendError && error.retryable) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /framebuffer surface|display has no|is not booted|not attached|no display/iu.test(message);
}

/** Enough to cross a long Settings list; short enough to fail fast on a typo. */
export const DEVICE_DEFAULT_MAX_SCROLLS = 8;

export type DeviceEventListener = (event: DeviceEvent) => void;

/** Who pointed a thread at a device. Only a person's choice keeps a Ryco-owned simulator running. */
export type DeviceAttachmentSource = "user" | "agent";

export interface DeviceManagerOptions {
  readonly backend: DeviceBackend;
  readonly transport?: DeviceFrameTransport;
  readonly idleShutdownMs?: number;
  readonly bootLimit?: number;
  /** Remembers Ryco's boots across a crash; defaults to remembering nothing. */
  readonly bootOwnership?: BootOwnershipStore;
  readonly attachDeadlineMs?: number;
  readonly attachRetryMs?: number;
  readonly setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void;
  readonly now?: () => number;
}

interface ThreadAttachment {
  version: number;
  attachedDeviceUdid: string | null;
  /** Set by every attach. Agent attachments are metadata: they never keep a device booted. */
  attachmentSource: DeviceAttachmentSource;
  /** Devices this thread's agent used, per provider turn, held until that turn stops being active. */
  readonly agentDevicesByTurn: Map<string, Set<string>>;
  agentActiveCount: number;
  lastError: string | null;
  /** Non-null while the attachment is still coming up. */
  attachPhase: DeviceAttachPhase | null;
  /**
   * Identifies the attach attempt currently in flight. A retry loop that finds
   * a different token has been superseded — the user picked another device, or
   * detached — and stops without touching the newer attempt's state.
   */
  attachToken: number;
  /**
   * Device this thread has already asked the pane to open for. An agent driving
   * a device calls a tool every few seconds, so the second and later requests
   * would be pure noise; this is what makes them a no-op.
   */
  paneSurfacedUdid: string | null;
}

export class DeviceManager {
  private readonly backend: DeviceBackend;
  private readonly transport: DeviceFrameTransport;
  private readonly idleShutdownMs: number;
  private readonly bootLimit: number;
  private readonly bootOwnership: BootOwnershipStore;
  private readonly attachDeadlineMs: number;
  private readonly attachRetryMs: number;
  private readonly schedule: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;
  private readonly now: () => number;

  private readonly threads = new Map<string, ThreadAttachment>();
  /** Devices this manager booted, and therefore may shut down again. */
  private readonly rycoBooted = new Set<string>();
  /** Dead-owner evidence adopted by this manager until discovery/shutdown confirms release. */
  private readonly recoveryPending = new Set<string>();
  private readonly recoveryShutdowns = new Map<string, Promise<void>>();
  private recoveryInitialized = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryWork: Promise<readonly string[]> | undefined;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** The provider turn each thread is running, as the orchestration projection last reported it. */
  private readonly activeAgentTurns = new Map<string, string>();
  /**
   * Threads archived, trashed or deleted since their last turn started. Agent work still in
   * flight when one went away attaches nothing to it; its next turn or a user attach clears it.
   */
  private readonly removedThreads = new Set<string>();
  /** In-flight manager calls per device: pane RPCs, agent tools and Agent Control actions. */
  private readonly activeDeviceActions = new Map<string, number>();
  /** Idle shutdowns already handed to the backend, or the boot restoring one; new use waits for them. */
  private readonly idleShutdowns = new Map<string, Promise<void>>();
  private readonly streams = new Map<
    string,
    {
      active: boolean;
      activeGeneration: number;
      desired: boolean;
      generation: number;
      transition: Promise<void>;
    }
  >();
  private readonly deviceGenerations = new Map<string, number>();
  private readonly bootRevisions = new Map<string, number>();
  private nextBootRevision = 0;
  private readonly boots = new Map<string, Promise<DeviceBootResult>>();
  private readonly unsubscribeDisconnect: (() => void) | undefined;
  private readonly recording = new Set<string>();
  private readonly listeners = new Set<DeviceEventListener>();
  private clientStreams = 0;
  /** Open-pane requests no client stream heard, latest per thread. */
  private readonly unheardOpenRequests = new Map<
    string,
    { readonly event: DeviceEvent; readonly requestedAt: number }
  >();
  private disposed = false;

  constructor(options: DeviceManagerOptions) {
    this.backend = options.backend;
    this.transport = options.transport ?? new DeviceFrameTransport();
    this.idleShutdownMs = options.idleShutdownMs ?? DEVICE_IDLE_SHUTDOWN_MS;
    this.bootLimit = options.bootLimit ?? DEVICE_RYCO_BOOT_LIMIT;
    this.bootOwnership = options.bootOwnership ?? NULL_BOOT_OWNERSHIP;
    this.attachDeadlineMs = options.attachDeadlineMs ?? DEVICE_ATTACH_DEADLINE_MS;
    this.attachRetryMs = options.attachRetryMs ?? DEVICE_ATTACH_RETRY_MS;
    this.schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.now = options.now ?? Date.now;
    this.unsubscribeDisconnect = this.backend.onDisconnect?.((udids) => {
      for (const udid of udids) {
        this.bumpDeviceGeneration(udid);
        const stream = this.streams.get(udid);
        if (stream) {
          stream.desired = false;
          stream.active = false;
          stream.generation += 1;
        }
        this.transport.resetDevice(udid);
        if (!this.recoveryPending.has(udid)) this.rycoBooted.delete(udid);
        this.recording.delete(udid);
        this.clearIdleTimer(udid);
      }
      for (const [threadId, attachment] of this.threads) {
        if (!attachment.attachedDeviceUdid || !udids.includes(attachment.attachedDeviceUdid))
          continue;
        attachment.attachedDeviceUdid = null;
        attachment.attachToken += 1;
        attachment.attachPhase = null;
        attachment.lastError =
          "Device host disconnected. Refresh devices and select the device again.";
        void this.publish(threadId).catch(() => undefined);
      }
      void this.recordBootOwnership();
    });
  }

  private async recordBootOwnership(): Promise<void> {
    await this.bootOwnership.write([...this.rycoBooted]).catch(() => undefined);
  }

  /**
   * Shut down simulators a previous run booted and never got to clean up.
   *
   * Started at startup and retried while discovery or shutdown is uncertain.
   * A clean quit leaves an empty record, so this is a
   * no-op; a crash leaves udids behind, and without this they would linger
   * forever, because the next run sees them as user-booted and therefore
   * outside the cap, the idle sweep and the quit-time shutdown alike.
   *
   * Returns the udids it shut down so the caller can log them: silently killing
   * a simulator the user can see would be its own surprise.
   */
  async reclaimOrphanedBoots(
    isProcessAlive: (pid: number) => boolean = processIsAlive,
  ): Promise<readonly string[]> {
    if (this.disposed) return [];
    if (this.recoveryWork) return this.recoveryWork;
    if (this.recoveryTimer) this.cancel(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const work = this.recoverBoots(isProcessAlive).finally(() => {
      this.recoveryWork = undefined;
      if (!this.disposed && (!this.recoveryInitialized || this.recoveryPending.size > 0)) {
        this.recoveryTimer = this.schedule(() => {
          this.recoveryTimer = undefined;
          void this.reclaimOrphanedBoots(isProcessAlive).catch(() => undefined);
        }, 1000);
        this.recoveryTimer.unref?.();
      }
    });
    this.recoveryWork = work;
    return work;
  }

  private async recoverBoots(isProcessAlive: (pid: number) => boolean): Promise<readonly string[]> {
    if (!this.recoveryInitialized) {
      const recorded = await this.bootOwnership.read();
      if (this.disposed) return [];
      this.recoveryInitialized = true;
      if (
        recorded === null ||
        recorded.udids.length === 0 ||
        (recorded.pid > 0 && isProcessAlive(recorded.pid))
      )
        return [];
      for (const udid of recorded.udids) {
        this.recoveryPending.add(udid);
        this.rycoBooted.add(udid);
        this.bootRevisions.set(udid, ++this.nextBootRevision);
      }
      // Adopt the dead owner's evidence before any bounded/partial discovery.
      // Later normal boots and quit must also persist these unresolved reservations.
      await this.recordBootOwnership();
    }
    if (this.recoveryPending.size === 0) return [];
    const discovery = await this.discoverForBoot();
    if (this.disposed) return [];
    const reclaimed: string[] = [];
    for (const udid of this.recoveryPending) {
      if (!discovery.completeFor(udid)) continue;
      const device = discovery.devices.find((candidate) => candidate.udid === udid);
      if (device && device.state !== "shutdown") {
        // Publish the shutdown barrier before yielding. Explicit use either
        // removes the pending entry first, or waits for this shutdown to finish.
        const shutdown = (async () => {
          await this.backend.shutdown(udid);
          this.rycoBooted.delete(udid);
          this.recoveryPending.delete(udid);
          await this.recordBootOwnership();
        })();
        this.recoveryShutdowns.set(udid, shutdown);
        try {
          await shutdown;
        } catch {
          continue;
        } finally {
          this.recoveryShutdowns.delete(udid);
        }
        reclaimed.push(udid);
      }
      this.recoveryPending.delete(udid);
      this.rycoBooted.delete(udid);
    }
    await this.recordBootOwnership();
    return reclaimed;
  }

  /** Waits without holding the process open, and shares the injected scheduler. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.schedule(() => resolve(), ms);
      timer.unref?.();
    });
  }

  // ── Events ─────────────────────────────────────────────────────────

  onEvent(listener: DeviceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A client's device event stream. Like {@link onEvent}, and it first hears the
   * open-pane requests made while no client streamed — each one handed to this
   * stream only, so a reconnect does not reopen a pane the user closed.
   */
  onClientEvent(listener: DeviceEventListener): () => void {
    const unsubscribe = this.onEvent(listener);
    this.clientStreams += 1;
    const now = this.now();
    const unheard = Array.from(this.unheardOpenRequests.values());
    this.unheardOpenRequests.clear();
    for (const { event, requestedAt } of unheard) {
      if (now - requestedAt >= DEVICE_OPEN_PANE_REQUEST_HOLD_MS) continue;
      try {
        listener(event);
      } catch {
        // The stream is gone; the request goes with it, as a live one would.
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.clientStreams -= 1;
      unsubscribe();
    };
  }

  // ── Queries ────────────────────────────────────────────────────────

  async availability(): Promise<DeviceAvailability> {
    return await this.backend.availability();
  }

  async list(options: { readonly includeShutdown?: boolean } = {}): Promise<DeviceListResult> {
    const availability = await this.backend.availability();
    const devices = await this.discover(availability, options);
    return {
      devices,
      availability,
      ...(this.backend.hostSummaries ? { hosts: this.backend.hostSummaries() } : {}),
    };
  }

  /**
   * Devices to show alongside an availability state.
   *
   * Discovery is gated only on the platform, never on full availability.
   * Listing runs on `simctl`, which works long before the native helper exists,
   * and the helper is only built on first attach. Requiring `available` here
   * deadlocked a fresh machine: the picker stayed empty because the helper was
   * unbuilt, and the helper stayed unbuilt because attaching needs a udid from
   * the picker. The pane shows the devices and the remaining setup step
   * together, which is what the setup checklist is for.
   */
  private async discover(
    availability: DeviceAvailability,
    options: { readonly includeShutdown?: boolean } = {},
  ): Promise<readonly DeviceDescriptor[]> {
    if (availability.kind === "unsupported-platform") return [];
    // Already reported through `availability`; an empty list is the honest
    // answer when simctl itself cannot run.
    const devices = await this.backend.listDevices(options).catch(() => []);
    return devices.map((device) => this.describe(device));
  }

  async getThreadState(threadId: string): Promise<ThreadDeviceState> {
    return await this.snapshot(threadId);
  }

  /** Devices the pane may offer as shutdown candidates when the cap is hit. */
  async rycoBootedDevices(): Promise<readonly DeviceDescriptor[]> {
    const discovery = await this.discoverForBoot();
    await this.reconcileRycoBooted(discovery);
    return discovery.devices
      .filter((device) => this.rycoBooted.has(device.udid))
      .map((device) => this.describe(device));
  }

  /** Safe lifecycle metadata used by scoped Agent Control stale-plan guards. */
  isRecording(udid: string): boolean {
    return this.recording.has(udid);
  }

  /** Exact thread attachments for cross-thread Agent Control isolation checks. */
  attachedThreadIds(udid: string): readonly string[] {
    return [...this.threads.entries()]
      .filter(([, attachment]) => attachment.attachedDeviceUdid === udid)
      .map(([threadId]) => threadId);
  }

  /**
   * Forget devices that are no longer running.
   *
   * The set is Ryco's own bookkeeping, but the simulators are not Ryco's to
   * keep: `simctl shutdown all` from a shell, Simulator.app quitting, a crashed
   * runtime, or the agent tidying up all shut a device down without telling us.
   * Every one of those left a phantom holding a slot, and three phantoms made
   * the pane refuse the next boot and offer to shut down devices that were
   * already off — including, absurdly, the one being asked for.
   *
   * Reconciled from the listing every caller already has rather than by polling:
   * the cap is only consulted on boot, and that path lists devices anyway.
   */
  private async discoverForBoot(targetUdid?: string): Promise<DeviceDiscovery> {
    const revisions = new Map(this.bootRevisions);
    const pendingAtStart = new Set(this.boots.keys());
    if (targetUdid !== undefined) pendingAtStart.delete(targetUdid);
    try {
      const discovery = this.backend.discoverDevices
        ? await this.backend.discoverDevices(targetUdid)
        : {
            devices: await this.backend.listDevices({ includeShutdown: true }),
            completeFor: () => true,
          };
      return {
        devices: discovery.devices,
        completeFor: (udid) =>
          discovery.completeFor(udid) &&
          !pendingAtStart.has(udid) &&
          (!this.rycoBooted.has(udid) || revisions.get(udid) === this.bootRevisions.get(udid)),
      };
    } catch {
      return { devices: [], completeFor: () => false };
    }
  }

  private async reconcileRycoBooted({ devices, completeFor }: DeviceDiscovery): Promise<void> {
    let changed = false;
    const running = new Set(
      devices
        .filter((device) => device.state === "booted" || device.state === "booting")
        .map((device) => device.udid),
    );
    for (const udid of this.rycoBooted) {
      if (running.has(udid) || this.boots.has(udid) || !completeFor(udid)) continue;
      this.rycoBooted.delete(udid);
      this.recoveryPending.delete(udid);
      changed = true;
      this.clearIdleTimer(udid);
    }
    if (changed) await this.recordBootOwnership();
  }

  // ── Boot / shutdown ────────────────────────────────────────────────

  /** Explicit use adopts an orphan into normal ownership without freeing its slot. */
  private claimRecoveredDevice(udid: string): Promise<void> | undefined {
    if (this.recoveryPending.delete(udid)) {
      this.bootRevisions.set(udid, ++this.nextBootRevision);
    }
    return this.recoveryShutdowns.get(udid);
  }

  boot(udid: string): Promise<DeviceBootResult> {
    if (this.disposed) return Promise.reject(new DeviceBackendError("Device manager disposed"));
    const existing = this.boots.get(udid);
    if (existing) return existing;
    const boot = this.bootDevice(udid).finally(() => {
      this.boots.delete(udid);
    });
    this.boots.set(udid, boot);
    return boot;
  }

  private async bootDevice(udid: string): Promise<DeviceBootResult> {
    // Booting under a simctl shutdown races it; wait the shutdown out, then
    // boot normally. Not the restoring wait: that one boots through `boot()`,
    // which would hand this very boot back to it and deadlock.
    await this.awaitIssuedIdleShutdown(udid);
    const recoveryShutdown = this.claimRecoveredDevice(udid);
    if (recoveryShutdown) await recoveryShutdown.catch(() => undefined);
    const discovery = await this.discoverForBoot(udid);
    const { devices } = discovery;
    // Devices that stopped without Ryco doing it still held their slots, so
    // three shutdowns from a shell were enough to make every later boot refuse.
    await this.reconcileRycoBooted(discovery);
    const known = devices.find((device) => device.udid === udid) ?? null;
    if (!known || !discovery.completeFor(udid) || this.disposed)
      throw new DeviceBackendError("Unknown, disconnected or disposed device");
    // Viewing an already-booted device is uncapped: the cap exists to stop
    // Ryco from accumulating simulators, not to limit what the user watches.
    if (known?.state === "booted") {
      return { kind: "booted", device: this.describe(known) };
    }
    if (this.rycoBooted.size >= this.bootLimit) {
      return {
        kind: "boot-limit-reached",
        limit: this.bootLimit,
        rycoBooted: devices
          .filter((device) => this.rycoBooted.has(device.udid))
          .map((device) => this.describe(device)),
      };
    }

    // The slot is taken before the await, not after it. A boot runs for the
    // better part of a minute, so two threads asking for different simulators
    // would both read a size under the limit and both proceed, and the cap that
    // exists to stop Ryco accumulating multi-gigabyte simulators would be
    // exceeded by however many requests arrived inside that window.
    this.rycoBooted.add(udid);
    this.bootRevisions.set(udid, ++this.nextBootRevision);
    let device: DeviceDescriptor;
    try {
      device = await this.backend.boot(udid);
    } catch (cause) {
      // A reservation only stands for a boot that actually happened; holding it
      // after a failure would leak the slot for the process lifetime.
      this.rycoBooted.delete(udid);
      throw cause;
    }
    // Persisted before the caller is told the boot succeeded, so a crash in the
    // next instant still leaves a record to reclaim from.
    await this.recordBootOwnership();
    // A device booted for a new purpose is no longer idle-condemned.
    this.clearIdleTimer(udid);
    await this.publishAllThreads();
    return { kind: "booted", device: { ...device, bootSource: "ryco" } };
  }

  async shutdown(udid: string): Promise<void> {
    // A grace firing during this shutdown would start a second one.
    this.clearIdleTimer(udid);
    // An idle shutdown already with simctl finishes first: a second shutdown
    // would race it, and simctl refuses a device that is already off.
    if (this.idleShutdowns.has(udid)) {
      await this.awaitIssuedIdleShutdown(udid);
      if (!this.rycoBooted.has(udid)) return;
    }
    // A refused shutdown does not start the grace: the SSH device host's
    // manager only boots and shuts down, and a timer there would later power
    // off a device the coding node is using. The caller sees the error.
    await this.runShutdown(udid, false);
  }

  /**
   * `onlyIfIdle` is the idle grace's shutdown: it gives up, and reports false,
   * when a consumer arrived while the stream was being torn down.
   */
  private async runShutdown(udid: string, onlyIfIdle: boolean): Promise<boolean> {
    const resumeTesting = this.backend.suspendTesting(udid);
    try {
      return await this.shutdownDeviceResources(udid, onlyIfIdle);
    } finally {
      resumeTesting();
    }
  }

  private async shutdownDeviceResources(udid: string, onlyIfIdle: boolean): Promise<boolean> {
    if (!onlyIfIdle) this.bumpDeviceGeneration(udid);
    await this.boots.get(udid)?.catch(() => undefined);
    // A recording makes the device busy, so an idle shutdown never has one to
    // stop; one that started during the teardown below aborts it instead.
    if (!onlyIfIdle) await this.stopRecordingIfActive(udid).catch(() => undefined);
    await this.stopStream(udid);
    if (onlyIfIdle) {
      // Stream teardown yielded: a tool, a user attachment or a viewer may have
      // arrived. Only now is the shutdown certain, so only now are in-flight
      // operations made stale; an aborted idle shutdown must not break them.
      if (this.disposed || this.isDeviceBusy(udid) || !this.rycoBooted.has(udid)) return false;
      this.bumpDeviceGeneration(udid);
    }
    // A thread that attaches while simctl shuts the device down keeps its
    // attachment: its `attach` waits for this shutdown and boots the device again.
    const attachTokens = onlyIfIdle
      ? new Map(Array.from(this.threads, ([threadId, entry]) => [threadId, entry.attachToken]))
      : null;
    await this.backend.shutdown(udid);
    this.rycoBooted.delete(udid);
    this.recoveryPending.delete(udid);
    await this.recordBootOwnership();
    this.clearIdleTimer(udid);
    // Any thread watching this device loses its attachment rather than pointing
    // at a shut-down simulator.
    for (const [threadId, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid !== udid) continue;
      if (attachTokens !== null && attachTokens.get(threadId) !== attachment.attachToken) continue;
      attachment.attachedDeviceUdid = null;
      attachment.attachPhase = null;
      // The pane no longer shows this device, so the agent's next use of it,
      // once it is booted again, must attach and surface it again.
      if (attachment.paneSurfacedUdid === udid) attachment.paneSurfacedUdid = null;
      // Stops a retry loop still waiting on this device's display: it is not
      // coming, and the loop would otherwise time out into a misleading error.
      attachment.attachToken += 1;
      await this.publish(threadId);
    }
    await this.publishAllThreads();
    return true;
  }

  // ── Attachment ─────────────────────────────────────────────────────

  /**
   * Point a thread at a device and bring its stream up.
   *
   * Resolves as soon as the attachment is recorded, not when the picture
   * arrives: a cold boot publishes its display seconds after reporting itself
   * booted, and holding the RPC open for that left the picker on "Choose a
   * simulator" and the screen blank for the whole wait. The stream comes up in
   * the background, pushing a phase per stage, and the pane renders the device
   * it was told to show from the first frame of the interaction.
   *
   * `source` says who chose the device. A person's attachment keeps a
   * Ryco-owned device up; an agent's is metadata and lets it idle out.
   */
  async attach(
    threadId: string,
    udid: string,
    source: DeviceAttachmentSource = "user",
  ): Promise<ThreadDeviceState> {
    this.assertNotDisposed();
    if (source === "user") this.removedThreads.delete(threadId);
    const recoveryShutdown = this.claimRecoveredDevice(udid);
    if (recoveryShutdown) {
      await recoveryShutdown.catch(() => undefined);
      const result = await this.boot(udid);
      if (result.kind !== "booted") throw new DeviceBackendError("Device boot limit reached");
      this.assertNotDisposed();
    }
    const attachment = this.threadState(threadId);
    const previous = attachment.attachedDeviceUdid;
    // Cleared before releasing: `releaseDevice` asks whether anyone still holds
    // the device, and this thread must no longer count as a holder.
    attachment.attachedDeviceUdid = udid;
    // Never a downgrade: an agent attaching the device a person already picked
    // (an approved Agent Control attach, say) leaves it theirs.
    attachment.attachmentSource =
      previous === udid && attachment.attachmentSource === "user" ? "user" : source;
    attachment.lastError = null;
    attachment.attachPhase = "connecting";
    const token = (attachment.attachToken += 1);
    this.clearIdleTimer(udid);
    try {
      // Counted as an in-flight call until an idle shutdown already handed to
      // the backend is waited out, so even an agent attachment, which holds
      // nothing by itself, aborts that shutdown or gets the device booted again.
      this.beginDeviceAction(udid);
      try {
        if (previous !== null && previous !== udid) await this.releaseDevice(previous, "switched");
        await this.waitForIdleShutdown(udid);
      } catch (error) {
        // The device could not be brought back (the boot cap, say): the thread
        // must not keep pointing at a shut-down simulator.
        if (
          !this.disposed &&
          attachment.attachToken === token &&
          this.threads.get(threadId) === attachment
        ) {
          attachment.attachedDeviceUdid = null;
          attachment.attachPhase = null;
          attachment.attachToken += 1;
          attachment.lastError = errorMessage(error);
          await this.publish(threadId).catch(() => undefined);
        }
        throw error;
      } finally {
        this.endDeviceAction(udid);
      }
      this.assertNotDisposed();
      // Superseded while waiting: the newer attach or detach owns the state.
      if (attachment.attachToken !== token) return await this.snapshot(threadId);

      // Already streaming (another thread is watching the same device): there is
      // nothing to wait for, so the phase clears without a round trip.
      if (this.streams.get(udid)?.active) {
        attachment.attachPhase = null;
        return await this.publish(threadId);
      }

      const state = await this.publish(threadId);
      void this.bringStreamUp(threadId, udid, token);
      return state;
    } finally {
      // A person's attachment cancels the grace; an agent's may start it.
      this.updateIdleTimer(udid);
    }
  }

  /**
   * Open the stream, waiting out the failures that only mean "not ready yet".
   *
   * The retry is the whole point: attaching to a device that has not published
   * its display fails every time, and a single attempt therefore turned every
   * cold boot into a dead pane with an error under it. Bounded by
   * `DEVICE_ATTACH_DEADLINE_MS` so a device that genuinely never comes up ends
   * in a message naming what to do instead of an endless spinner.
   */
  private async bringStreamUp(threadId: string, udid: string, token: number): Promise<void> {
    const deadline = this.now() + this.attachDeadlineMs;
    let sawTransientFailure = false;

    while (!this.disposed) {
      const attachment = this.threads.get(threadId);
      // Superseded or gone: another attach owns this thread's state now.
      if (!attachment || attachment.attachToken !== token) return;

      try {
        const started = await this.startStream(udid);
        if (!started || attachment.attachToken !== token || this.disposed) return;
        if (attachment.attachPhase === null && attachment.lastError === null) return;
        attachment.attachPhase = null;
        attachment.lastError = null;
        await this.publish(threadId);
        return;
      } catch (error) {
        if (attachment.attachToken !== token || this.disposed) return;
        if (!isTransientAttachFailure(error)) {
          attachment.attachPhase = null;
          attachment.lastError = errorMessage(error);
          await this.publish(threadId);
          return;
        }
        // The device is up but has no screen yet, which is a different wait
        // from booting and worth saying so.
        const phase: DeviceAttachPhase = /is not booted/iu.test(errorMessage(error))
          ? "booting"
          : "waiting-for-display";
        if (attachment.attachPhase !== phase) {
          attachment.attachPhase = phase;
          await this.publish(threadId);
        }
        sawTransientFailure = true;
      }

      if (this.now() >= deadline) break;
      await this.delay(this.attachRetryMs);
    }

    const attachment = this.threads.get(threadId);
    if (!attachment || attachment.attachToken !== token) return;
    attachment.attachPhase = null;
    // Only the display-wait deadline gets the tailored message; a disposal or a
    // shutdown mid-wait is not the user's problem to act on.
    if (sawTransientFailure && !this.disposed) attachment.lastError = DISPLAY_TIMEOUT_MESSAGE;
    await this.publish(threadId);
  }

  /**
   * Point a thread at the device its agent is driving, unless the user already
   * pointed it somewhere else.
   *
   * Auto-opening the pane is only useful if there is something to watch: before
   * this, an agent's launch opened a pane still asking the user to pick a
   * simulator, so they stared at a black phone while the agent worked. The
   * attachment is what makes `ThreadDeviceState.attachedDeviceUdid` non-null,
   * and the pane's existing logic starts the stream from there.
   *
   * Never steals: a thread already attached to a different device keeps it,
   * because that attachment reflects a deliberate choice by the user and the
   * agent's device is still reachable through the picker. Idempotent, so
   * repeated launches on the same device cost nothing.
   *
   * The attachment is the agent's, so it never keeps the device booted: the
   * agent's turn hold does that while the turn runs. A thread already on the
   * same device keeps whoever chose it.
   */
  async ensureThreadAttached(threadId: string, udid: string): Promise<void> {
    if (this.removedThreads.has(threadId)) return;
    const attached = this.threadState(threadId).attachedDeviceUdid;
    if (attached === udid) return;
    if (attached !== null) return;
    await this.attach(threadId, udid, "agent");
  }

  async detach(threadId: string): Promise<ThreadDeviceState> {
    return await this.detachThread(threadId, "detached");
  }

  private async detachThread(
    threadId: string,
    reason: "detached" | "removed",
  ): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const udid = attachment.attachedDeviceUdid;
    attachment.attachedDeviceUdid = null;
    attachment.attachPhase = null;
    // Abandons any attach still retrying in the background, so it cannot
    // resurrect a phase or an error on a thread that is no longer watching.
    attachment.attachToken += 1;
    if (udid !== null) await this.releaseDevice(udid, reason);
    return await this.publish(threadId);
  }

  /**
   * Thread archive, trash or deletion is terminal for its attachment and its
   * agent's holds; treat it as a detach and let the grace decide the rest.
   * Unlike a detach, it leaves a recording running while a person on another
   * thread still watches the device (see `releaseDevice`).
   */
  async handleThreadRemoved(threadId: string): Promise<void> {
    this.removedThreads.add(threadId);
    // Bounded: an id is forgotten after a thousand later removals.
    if (this.removedThreads.size > 1_000) {
      const oldest = this.removedThreads.values().next().value;
      if (oldest !== undefined) this.removedThreads.delete(oldest);
    }
    // First: a thread can have a known turn and no device record yet.
    this.activeAgentTurns.delete(threadId);
    const attachment = this.threads.get(threadId);
    if (!attachment) return;
    const held = new Set<string>();
    for (const devices of attachment.agentDevicesByTurn.values()) {
      for (const udid of devices) held.add(udid);
    }
    attachment.agentDevicesByTurn.clear();
    await this.detachThread(threadId, "removed");
    if (this.threads.get(threadId) === attachment) this.threads.delete(threadId);
    for (const udid of held) this.updateIdleTimer(udid);
  }

  // ── Streaming ──────────────────────────────────────────────────────

  /**
   * Register a WebSocket sink for a device's video. The backend stream is
   * started lazily and stopped when the last subscriber and attachment go away.
   *
   * A viewer keeps a Ryco-owned device up. One that arrives while an idle
   * shutdown is already with the backend waits for it, and the device is booted
   * again for it before the stream starts.
   */
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    if (this.disposed) return () => {};
    const unsubscribe = this.transport.subscribe(udid, sink);
    this.clearIdleTimer(udid);
    const start = () => {
      if (this.disposed || this.transport.deviceSubscriberCount(udid) === 0) return;
      void this.startStream(udid).catch(() => undefined);
    };
    // Synchronous when nothing is shutting down, exactly as before.
    if (this.idleShutdowns.has(udid)) {
      void this.waitForIdleShutdown(udid).then(start, () => undefined);
    } else {
      start();
    }
    return () => {
      unsubscribe();
      this.updateIdleTimer(udid);
      // Capture stops as soon as the last viewer goes, whether or not a thread
      // is still attached. Collapsing the pane closes the frame socket but
      // leaves the attachment, and gating this on the attachment too meant the
      // helper kept reading the framebuffer and encoding H.264 for nobody,
      // indefinitely. An agent-driven attachment that never opens a pane cost
      // the same. The attachment is metadata and survives; only the encode
      // stops, and `subscribeFrames` starts it again on the next subscriber.
      if (this.transport.deviceSubscriberCount(udid) === 0) {
        void this.stopStream(udid).catch(() => undefined);
      }
    };
  }

  // ── Control plane ──────────────────────────────────────────────────
  //
  // Every control call below (input, install, launch, testing, open URL,
  // screenshot, accessibility tree, starting a recording) goes through
  // `withDeviceAction`: the call holds the device up while it runs, restarts
  // the idle grace when it ends, and waits out an idle shutdown already handed
  // to the backend instead of racing a half-shut simulator. A new control
  // method must do the same.
  //
  // The other backend calls are lifecycle, not control, and are safe without
  // it: `boot` waits out an issued idle shutdown itself, `shutdown` defers to
  // one, `attach` and `subscribeFrames` wait before they start a stream,
  // stream transitions are serialized and the idle shutdown tears the stream
  // down before simctl runs (a keyframe request finds it inactive), and
  // `stopRecording` only runs for a recording, which keeps the device busy.

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.tap(udid, x, y));
  }

  /**
   * Tap the element a label names, scrolling it into view first if needed.
   *
   * The tree is read fresh rather than cached: a stale frame is exactly how a
   * tap lands on whatever scrolled into that position instead. Returns the
   * node so the caller can report what it actually hit and its state.
   */
  async tapElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const assertCurrent = this.operationGuard(udid);
    const match = await this.scrollToElement(udid, target, options);
    assertCurrent();
    await this.withDeviceAction(udid, () => this.backend.tap(udid, match.point.x, match.point.y));
    return match;
  }

  /**
   * Bring the element a label names into the tappable band and return it.
   *
   * The swipe-describe-check loop lives here rather than in the agent because
   * it is motor control, not judgement: an agent driving it by hand guesses
   * distances, overshoots, and re-describes between every attempt. Already
   * visible targets cost one describe and no swipes.
   *
   * A label missing from the tree is treated as "not reached yet" rather than
   * as a failure. Long lists are virtualized, so UIKit only materializes the
   * rows near the viewport: Settings genuinely has no "Developer" node until
   * scrolling gets close to it. The loop keeps paging down while the label is
   * absent, and only reports it missing once the list stops moving.
   */
  async scrollToElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const assertCurrent = this.operationGuard(udid);
    const maxScrolls = options.maxScrolls ?? DEVICE_DEFAULT_MAX_SCROLLS;
    let tree = await this.describeUi(udid);
    assertCurrent();
    let match = this.locate(tree.root, target);
    let previousPosition: string | null = null;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls += 1) {
      // Nothing to aim at yet: page down by a screenful to materialize more of
      // the list. Once the node exists, the planner takes over and aims at it.
      const step =
        match === null ? this.pageDownStep(tree.root) : planScrollStep(match.node, tree.root);
      if (step === null) return match as DeviceUiTargetMatch;

      const positionBefore = match === null ? null : match.node.frame.y;
      assertCurrent();
      await this.withDeviceAction(udid, () => this.backend.swipe(udid, step));
      assertCurrent();
      tree = await this.describeUi(udid);
      assertCurrent();
      match = this.locate(tree.root, target);

      // Fixed chrome (a navigation bar's back button, a tab bar item) and the
      // last rows of a list at its end sit outside the safe band and cannot be
      // scrolled into it. A visible target that one swipe left where it was is
      // tapped in place rather than reported out of reach. (Synara #1924 does
      // this for identified navigation and tab bars; this node's tree has no
      // such containers, so not moving is the evidence.)
      if (
        match !== null &&
        match.onScreen &&
        positionBefore !== null &&
        Math.abs(match.node.frame.y - positionBefore) < 0.5
      ) {
        return match;
      }

      // A list at its end keeps rendering the same thing; swiping again would
      // burn the whole budget to no effect. Compared across the visible labels
      // as well as the target's own position, since an absent target has none.
      const position = match === null ? this.treeFingerprint(tree.root) : `y:${match.node.frame.y}`;
      if (previousPosition !== null && position === previousPosition) {
        throw new DeviceUiTargetError(
          match === null
            ? `No element labelled ${JSON.stringify(target.label)} appeared after scrolling to the end of the screen.`
            : `Scrolling stopped moving ${JSON.stringify(target.label)} after ${scrolls + 1} ` +
                `swipe${scrolls === 0 ? "" : "s"}; the list appears to be at its end and the element is still out of reach.`,
          match === null ? visibleLabels(tree.root) : [],
          match === null,
        );
      }
      previousPosition = position;
    }

    if (match !== null && planScrollStep(match.node, tree.root) === null) return match;
    throw new DeviceUiTargetError(
      `Could not bring ${JSON.stringify(target.label)} into view within ${maxScrolls} swipes. ` +
        `Raise maxSwipes, or scroll manually with device_swipe if it sits in a nested scroll area.`,
      match === null ? visibleLabels(tree.root) : [],
      match === null,
    );
  }

  /** The match, or null when the label has not been rendered into the tree yet. */
  private operationGuard(udid: string): () => void {
    const generation = this.deviceGenerations.get(udid) ?? 0;
    return () => {
      if (this.disposed || generation !== (this.deviceGenerations.get(udid) ?? 0)) {
        throw new DeviceBackendError(
          "Stale device operation: device host disconnected or lifecycle changed",
        );
      }
    };
  }

  private locate(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch | null {
    try {
      return findTarget(root, target);
    } catch (error) {
      // Only absence means "keep scrolling". An ambiguous label is a real
      // answer the caller must resolve, so it propagates immediately.
      if (error instanceof DeviceUiTargetError && error.notFound) return null;
      throw error;
    }
  }

  /** A blind screenful downward, for when the target has not appeared yet. */
  private pageDownStep(root: DeviceUiNode): DeviceSwipeGesture {
    const midX = root.frame.x + root.frame.width / 2;
    const centre = root.frame.y + root.frame.height / 2;
    const distance = root.frame.height * 0.6;
    return {
      fromX: midX,
      fromY: centre + distance / 2,
      toX: midX,
      toY: centre - distance / 2,
      durationMs: SCROLL_SWIPE_DURATION_MS,
    };
  }

  /** What is on screen right now, to tell a moving list from a stuck one. */
  private treeFingerprint(root: DeviceUiNode): string {
    return visibleLabels(root).join("|");
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.swipe(udid, gesture));
  }

  async typeText(udid: string, text: string): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.typeText(udid, text));
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.keyEvent(udid, event));
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.pressButton(udid, button));
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    return await this.withDeviceAction(udid, () => this.backend.install(udid, appPath));
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult> {
    return await this.withDeviceAction(udid, () =>
      this.backend.launch(udid, bundleId, launchArguments),
    );
  }

  async testing(input: DeviceTestingInput): Promise<void> {
    await this.withDeviceAction(input.udid, () => this.backend.testing(input));
  }

  async readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult> {
    return await this.backend.readLogs(udid, query);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.openUrl(udid, url));
  }

  async screenshot(
    udid: string,
    options: { readonly save?: boolean } = {},
  ): Promise<DeviceScreenshotResult> {
    return await this.withDeviceAction(udid, () => this.backend.screenshot(udid, options));
  }

  /** A recording keeps a Ryco-owned device up until it is stopped. */
  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    this.assertNotDisposed();
    const alreadyTracked = this.recording.has(udid);
    this.recording.add(udid);
    this.clearIdleTimer(udid);
    try {
      return await this.withDeviceAction(udid, () => this.backend.startRecording(udid));
    } catch (error) {
      if (!alreadyTracked) this.recording.delete(udid);
      this.updateIdleTimer(udid);
      throw error;
    }
  }

  /**
   * Forgets the recording even when the stop fails: the backend has ended it
   * either way (simctl was interrupted, or nothing was recording), and a
   * recording the manager still believed in would keep the device up for good.
   */
  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    try {
      return await this.backend.stopRecording(udid);
    } finally {
      this.recording.delete(udid);
      this.updateIdleTimer(udid);
    }
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    return await this.withDeviceAction(udid, () => this.backend.describeUi(udid));
  }

  // ── Agent integration ──────────────────────────────────────────────

  /**
   * Wrap one agent-driven action so the pane can show its "agent is using this
   * device" badge for exactly as long as the action runs. Nested calls are
   * counted, so overlapping tool calls do not clear the badge early.
   *
   * With `deviceUse`, the action also holds that device: up while it runs, and
   * afterwards for as long as the thread's provider turn is still running (see
   * `observeThreadTurn`). It waits out an idle shutdown already handed to the
   * backend, which boots the device again first.
   *
   * A call admitted before the projection reported any turn joins the turn
   * running when it ends: a provider tool call always runs inside a turn, and
   * the projection may lag behind it. `joinLateTurn: false` turns that off for
   * actions that need not run inside one (an approved Agent Control proposal
   * can execute after its turn ended, and must not hold a later, unrelated one).
   */
  async withAgentActivity<A>(
    threadId: string,
    action: () => Promise<A>,
    deviceUse?: { readonly udid: string; readonly joinLateTurn?: boolean },
  ): Promise<A> {
    const udid = deviceUse?.udid;
    if (udid !== undefined) this.assertNotDisposed();
    const attachment = this.threadState(threadId);
    let held = false;
    if (udid !== undefined) {
      this.clearIdleTimer(udid);
      this.beginDeviceAction(udid);
      held = this.recordAgentUse(threadId, udid);
    }
    // Captured before any wait: overlapping calls may already be counted.
    const becameActive = attachment.agentActiveCount === 0;
    attachment.agentActiveCount += 1;
    try {
      if (udid !== undefined) await this.waitForIdleShutdown(udid);
      // Removal or disposal during the wait: publishing would resurrect the record.
      if (becameActive && !this.disposed && this.threads.get(threadId) === attachment) {
        await this.publish(threadId);
      }
      if (udid !== undefined) this.assertNotDisposed();
      return await action();
    } finally {
      attachment.agentActiveCount = Math.max(0, attachment.agentActiveCount - 1);
      if (udid !== undefined) {
        this.endDeviceAction(udid);
        // A call admitted just before the projection reported its turn joins it.
        if (!held && (deviceUse?.joinLateTurn ?? true)) this.recordAgentUse(threadId, udid);
        this.updateIdleTimer(udid);
      }
      if (
        !this.disposed &&
        this.threads.get(threadId) === attachment &&
        attachment.agentActiveCount === 0
      ) {
        await this.publish(threadId);
      }
    }
  }

  /**
   * The orchestration projection's running turn for a thread, from every
   * `thread.session-set`. Holds of every other turn end here: a turn that is
   * no longer the running one holds nothing. Cheap when the thread holds no
   * device, which is nearly always.
   */
  observeThreadTurn(threadId: string, activeTurnId: string | null): void {
    if (this.disposed) return;
    if (activeTurnId === null) this.activeAgentTurns.delete(threadId);
    else {
      this.activeAgentTurns.set(threadId, activeTurnId);
      // A new turn: the thread is back (restored from the archive or the trash).
      this.removedThreads.delete(threadId);
    }
    const attachment = this.threads.get(threadId);
    if (!attachment || attachment.agentDevicesByTurn.size === 0) return;
    const released = new Set<string>();
    for (const [turnId, devices] of attachment.agentDevicesByTurn) {
      // The running turn keeps its holds.
      if (turnId === activeTurnId) continue;
      attachment.agentDevicesByTurn.delete(turnId);
      for (const udid of devices) released.add(udid);
    }
    for (const udid of released) this.updateIdleTimer(udid);
  }

  /**
   * Run an agent action that does not go through `withAgentActivity` (an
   * approved Agent Control boot or attach), holding `udid` for the provider
   * turn the thread is running when the action starts, if the projection has
   * reported one. Never a turn that starts while it runs: an approval can land
   * after the turn that asked for it ended. When the action ends, the grace
   * starts if nothing else holds the device.
   */
  async holdForAgentTurn<A>(threadId: string, udid: string, action: () => Promise<A>): Promise<A> {
    this.recordAgentUse(threadId, udid);
    try {
      return await action();
    } finally {
      this.updateIdleTimer(udid);
    }
  }

  private recordAgentUse(threadId: string, udid: string): boolean {
    if (this.disposed) return false;
    // Turn first: a removed thread has no known turn, so this never resurrects its record.
    const turnId = this.activeAgentTurns.get(threadId);
    if (turnId === undefined) return false;
    // `threadState`, not `threads.get`: an Agent Control boot attaches nothing,
    // so the thread may have no device record yet, and the boot must still be
    // held for the running turn.
    const attachment = this.threadState(threadId);
    const devices = attachment.agentDevicesByTurn.get(turnId) ?? new Set<string>();
    devices.add(udid);
    attachment.agentDevicesByTurn.set(turnId, devices);
    return true;
  }

  /** Auto-open the pane when an agent puts an app on a device. */
  requestOpenPane(threadId: string, udid: string, reason: DeviceOpenPaneReason): void {
    this.threadState(threadId).paneSurfacedUdid = udid;
    const event: DeviceEvent = {
      type: "device.open-pane-requested",
      threadId: ThreadId.make(threadId),
      udid,
      reason,
    };
    if (this.clientStreams === 0) {
      const now = this.now();
      for (const [heldThreadId, held] of this.unheardOpenRequests) {
        if (now - held.requestedAt >= DEVICE_OPEN_PANE_REQUEST_HOLD_MS) {
          this.unheardOpenRequests.delete(heldThreadId);
        }
      }
      this.unheardOpenRequests.set(threadId, { event, requestedAt: now });
    }
    this.emit(event);
  }

  /**
   * Put the agent's device in front of the user: attach the thread to it so the
   * pane has something to stream, then ask the pane to open.
   *
   * Every device interaction calls this, not just install and launch. An agent
   * working on an app that is already running never installs or launches
   * anything, so gating on those left the user watching a blank right side for
   * the whole turn while the agent tapped through their app.
   *
   * Interactions arrive every few seconds, so this is a no-op once the pane has
   * been surfaced for that device on that thread: repeating the request would
   * emit an event per tap and could yank a user who navigated away back to the
   * pane. Attaching first means the open request lands on a state that already
   * names a device rather than the empty picker.
   */
  async surfaceDeviceForAgent(
    threadId: string,
    udid: string,
    reason: DeviceOpenPaneReason,
  ): Promise<void> {
    // Agent work that outlived its thread's archive, trash or deletion surfaces nothing.
    if (this.removedThreads.has(threadId)) return;
    if (this.threadState(threadId).paneSurfacedUdid === udid) return;
    await this.ensureThreadAttached(threadId, udid).catch(() => undefined);
    this.requestOpenPane(threadId, udid, reason);
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    this.threadState(threadId).lastError = message;
    await this.publish(threadId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * App quit: shut down everything Ryco booted, leave the user's devices
   * alone, and release the backend.
   */
  async dispose(): Promise<void> {
    const resumeTesting = this.backend.suspendTesting();
    try {
      await this.disposeDeviceResources();
    } finally {
      resumeTesting();
    }
  }

  private async disposeDeviceResources(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.recoveryTimer) this.cancel(this.recoveryTimer);
    await this.recoveryWork?.catch(() => undefined);
    for (const [, timer] of this.idleTimers) this.cancel(timer);
    this.idleTimers.clear();
    // An idle shutdown already with the backend finishes first, so the loop
    // below neither shuts that device down twice nor races it.
    await Promise.allSettled(this.idleShutdowns.values());
    this.activeAgentTurns.clear();
    this.unsubscribeDisconnect?.();
    await Promise.allSettled(this.boots.values());
    // Snapshotted: both loops mutate the set they are walking.
    const recording = Array.from(this.recording);
    const booted = Array.from(this.rycoBooted);
    await Promise.allSettled([...this.streams.keys()].map((udid) => this.stopStream(udid)));
    for (const udid of recording) await this.stopRecordingIfActive(udid).catch(() => undefined);
    for (const udid of booted) {
      try {
        await this.backend.shutdown(udid);
      } catch {
        continue;
      }
      this.rycoBooted.delete(udid);
      this.recoveryPending.delete(udid);
    }
    // A failed shutdown is still owned; leave evidence for the next process.
    if (this.rycoBooted.size > 0) await this.recordBootOwnership();
    else await this.bootOwnership.clear().catch(() => undefined);
    this.listeners.clear();
    this.unheardOpenRequests.clear();
    await this.backend.dispose().catch(() => undefined);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private threadState(threadId: string): ThreadAttachment {
    let attachment = this.threads.get(threadId);
    if (!attachment) {
      attachment = {
        version: 0,
        attachedDeviceUdid: null,
        attachmentSource: "user",
        agentDevicesByTurn: new Map(),
        agentActiveCount: 0,
        lastError: null,
        attachPhase: null,
        attachToken: 0,
        paneSurfacedUdid: null,
      };
      this.threads.set(threadId, attachment);
    }
    return attachment;
  }

  /**
   * Fill in the fields discovery cannot know: who booted the device, and its
   * screen geometry. Every descriptor the manager hands out passes through
   * here, so the pane always sees geometry once the device has been attached.
   */
  private describe(device: DeviceDescriptor): DeviceDescriptor {
    const bootSource = this.rycoBooted.has(device.udid) ? "ryco" : device.bootSource;
    const geometry = this.backend.geometry(device.udid) ?? device.geometry;
    if (bootSource === device.bootSource && geometry === device.geometry) return device;
    return { ...device, bootSource, ...(geometry ? { geometry } : {}) };
  }

  private isAttachedAnywhere(udid: string): boolean {
    for (const [, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid === udid) return true;
    }
    return false;
  }

  /** Whether a thread still has this device attached because a person chose it. */
  private isAttachedByPerson(udid: string): boolean {
    for (const [, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid === udid && attachment.attachmentSource === "user") {
        return true;
      }
    }
    return false;
  }

  private async startStream(udid: string): Promise<boolean> {
    if (this.disposed) return false;
    const stream = this.streamState(udid);
    stream.desired = true;
    await this.queueStreamReconciliation(udid);
    return stream.active && stream.desired;
  }

  /** Clear stale startup state from every thread now watching this device. */
  private async clearStreamStartupState(udid: string): Promise<void> {
    const cleared: string[] = [];
    for (const [threadId, attachment] of this.threads) {
      if (
        attachment.attachedDeviceUdid !== udid ||
        (attachment.lastError === null && attachment.attachPhase === null)
      ) {
        continue;
      }
      attachment.lastError = null;
      attachment.attachPhase = null;
      cleared.push(threadId);
    }
    for (const threadId of cleared) await this.publish(threadId);
  }

  /**
   * Force a fresh codec-config frame followed by a keyframe.
   *
   * There is no "emit an IDR now" call in the helper, and the encoder's natural
   * keyframe interval is seconds away, so a decoder that has lost sync would
   * otherwise sit frozen. Restarting the stream builds a new compression
   * session, which always emits parameter sets and an IDR as its first frames.
   *
   * Cached frames are dropped first so a late subscriber cannot be primed with
   * a keyframe from the previous generation.
   */
  async requestKeyframe(udid: string): Promise<void> {
    if (!this.streams.get(udid)?.active || this.disposed) return;
    await this.stopStream(udid);
    if (this.disposed || this.transport.deviceSubscriberCount(udid) === 0) return;
    await this.startStream(udid);
  }

  private streamState(udid: string) {
    let stream = this.streams.get(udid);
    if (!stream) {
      stream = {
        active: false,
        activeGeneration: -1,
        desired: false,
        generation: 0,
        transition: Promise.resolve(),
      };
      this.streams.set(udid, stream);
    }
    return stream;
  }

  private async stopStream(udid: string): Promise<void> {
    const stream = this.streamState(udid);
    stream.desired = false;
    stream.generation += 1;
    this.transport.resetDevice(udid);
    await this.queueStreamReconciliation(udid);
  }

  private queueStreamReconciliation(udid: string): Promise<void> {
    const stream = this.streamState(udid);
    const transition = stream.transition.then(() => this.reconcileStream(udid));
    stream.transition = transition.catch(() => undefined);
    return transition;
  }

  private async reconcileStream(udid: string): Promise<void> {
    const stream = this.streamState(udid);
    while (true) {
      const desired = !this.disposed && stream.desired;
      if (stream.active === desired && (!desired || stream.activeGeneration === stream.generation))
        return;
      if (stream.active) {
        stream.active = false;
        this.transport.resetDevice(udid);
        await this.backend.detachStream(udid);
        continue;
      }
      if (!desired) return;
      const generation = stream.generation;
      try {
        await this.backend.attachStream(udid, (frame) => {
          if (!this.disposed && stream.desired && stream.generation === generation)
            this.transport.publish(udid, frame);
        });
      } catch (error) {
        if (!this.disposed && stream.desired && stream.generation === generation) {
          stream.desired = false;
          throw error;
        }
        continue;
      }
      if (this.disposed || !stream.desired || stream.generation !== generation) {
        this.transport.resetDevice(udid);
        await this.backend.detachStream(udid);
        continue;
      }
      stream.active = true;
      stream.activeGeneration = generation;
      await this.clearStreamStartupState(udid);
    }
  }

  /**
   * A thread stopped pointing at this device. Stop the stream if nobody else
   * needs it, and either shut the device down or let the idle grace decide if
   * Ryco booted it.
   *
   * A switch shuts down immediately rather than waiting out the idle window.
   * The cap is three Ryco-booted devices, and each one costs a couple of GB
   * of RAM, so trying three simulators in a row filled every slot with devices
   * nobody was looking at and made the fourth pick prompt for a shutdown the
   * user had effectively already asked for. A plain detach still uses the idle
   * timer, because coming back to a device you just closed is common and
   * re-booting it costs a minute.
   *
   * User-booted devices are never touched by either path.
   *
   * A detach or a switch stops the device's recording: who started it is not
   * tracked, and the leaving pane may be the only one that knows about it.
   * Removing a thread (archive, trash, delete) is not a device action, so it
   * leaves the recording running while a person on another thread still
   * watches the device; that person's own detach stops it later. With only
   * agent attachments left it stops, or it would keep the device up for good.
   */
  private async releaseDevice(
    udid: string,
    reason: "detached" | "switched" | "removed" = "detached",
  ): Promise<void> {
    if (reason !== "removed" || !this.isAttachedByPerson(udid)) {
      await this.stopRecordingIfActive(udid).catch(() => undefined);
    }
    const attachedElsewhere = this.isAttachedAnywhere(udid);
    if (!attachedElsewhere && this.transport.deviceSubscriberCount(udid) === 0) {
      await this.stopStream(udid).catch(() => undefined);
    }
    if (!this.rycoBooted.has(udid)) return;
    // Viewers are ignored here: the switching pane closes the old device's
    // frame socket only after this attach resolves, so counting it would turn
    // every switch into a ten-minute grace and refill the cap, the failure
    // described above. Every other consumer still blocks the switch shutdown.
    if (
      reason === "switched" &&
      !attachedElsewhere &&
      !this.isDeviceBusy(udid, { countViewers: false })
    ) {
      this.clearIdleTimer(udid);
      // Failure here is not the switch's problem: the new device is already
      // attached, and the idle sweep at quit still cleans this one up.
      await this.shutdown(udid).catch(() => undefined);
      return;
    }
    this.updateIdleTimer(udid);
  }

  private async stopRecordingIfActive(udid: string): Promise<void> {
    if (!this.recording.has(udid)) return;
    await this.stopRecording(udid);
  }

  /** Never rejects: `waitForIdleShutdown` callers only need it to settle. */
  private async shutdownIfStillIdle(udid: string): Promise<void> {
    // Re-checked at fire time: a consumer may have arrived during the grace.
    if (this.disposed || this.isDeviceBusy(udid) || !this.rycoBooted.has(udid)) return;
    try {
      await this.runShutdown(udid, true);
    } catch {
      // simctl refused: the device is still Ryco's and still up, so the grace
      // starts over instead of leaving it holding a boot slot until quit.
      this.updateIdleTimer(udid);
    }
  }

  /**
   * Whether anything still needs this device up. Agent attachments are
   * metadata: they do not keep a simulator alive after work ends; the agent's
   * hold for its running turn does that. `countViewers: false` is only for the
   * device-switch path (see `releaseDevice`).
   */
  private isDeviceBusy(udid: string, options: { readonly countViewers?: boolean } = {}): boolean {
    if (this.boots.has(udid) || this.recording.has(udid) || this.activeDeviceActions.has(udid)) {
      return true;
    }
    if ((options.countViewers ?? true) && this.transport.deviceSubscriberCount(udid) > 0) {
      return true;
    }
    for (const attachment of this.threads.values()) {
      if (attachment.attachedDeviceUdid === udid && attachment.attachmentSource === "user") {
        return true;
      }
      for (const devices of attachment.agentDevicesByTurn.values()) {
        if (devices.has(udid)) return true;
      }
    }
    return false;
  }

  /**
   * Start the idle grace when the last consumer of a Ryco-owned device goes;
   * cancel it while one remains. A boot alone never starts it: the SSH device
   * host's manager only boots and shuts down, and the consumer that follows a
   * boot (an attachment, an agent hold) decides.
   */
  private updateIdleTimer(udid: string): void {
    if (this.disposed || !this.rycoBooted.has(udid) || this.recoveryPending.has(udid)) return;
    if (this.isDeviceBusy(udid)) {
      this.clearIdleTimer(udid);
      return;
    }
    if (this.idleTimers.has(udid)) return;
    const timer = this.schedule(() => {
      if (this.idleTimers.get(udid) !== timer) return;
      this.idleTimers.delete(udid);
      // The stored promise is the `finally`-wrapped one: `waitForIdleShutdown`
      // relies on the entry being gone once it settles.
      const shutdown = this.shutdownIfStillIdle(udid).finally(() => {
        if (this.idleShutdowns.get(udid) === shutdown) this.idleShutdowns.delete(udid);
      });
      this.idleShutdowns.set(udid, shutdown);
    }, this.idleShutdownMs);
    // A pending idle shutdown must not keep the process alive at exit; quit
    // shuts these devices down anyway.
    timer.unref?.();
    this.idleTimers.set(udid, timer);
  }

  /** Guard the shared native boundary, including pane RPCs that have no agent turn. */
  private async withDeviceAction<A>(udid: string, action: () => Promise<A>): Promise<A> {
    this.assertNotDisposed();
    this.clearIdleTimer(udid);
    this.beginDeviceAction(udid);
    try {
      await this.waitForIdleShutdown(udid);
      this.assertNotDisposed();
      return await action();
    } finally {
      this.endDeviceAction(udid);
      this.updateIdleTimer(udid);
    }
  }

  private beginDeviceAction(udid: string): void {
    this.activeDeviceActions.set(udid, (this.activeDeviceActions.get(udid) ?? 0) + 1);
  }

  /** Only the count; callers decide when to revisit the grace. */
  private endDeviceAction(udid: string): void {
    const remaining = (this.activeDeviceActions.get(udid) ?? 1) - 1;
    if (remaining <= 0) this.activeDeviceActions.delete(udid);
    else this.activeDeviceActions.set(udid, remaining);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new DeviceBackendError("Device manager disposed");
  }

  /**
   * Wait out an idle shutdown already handed to the backend: simctl cannot
   * take it back. If the device went down and is still needed, boot it again,
   * once for every consumer waiting, and within the boot cap.
   *
   * Reads the map synchronously on entry, and stores the restoration before it
   * yields, so concurrent consumers share one boot.
   */
  private async waitForIdleShutdown(udid: string): Promise<void> {
    const shutdown = this.idleShutdowns.get(udid);
    if (!shutdown) return;
    await shutdown;
    this.assertNotDisposed();
    // Another consumer resumed first and is already restoring the device.
    const resuming = this.idleShutdowns.get(udid);
    if (resuming !== undefined && resuming !== shutdown) {
      await resuming;
      this.assertNotDisposed();
      return;
    }
    if (this.rycoBooted.has(udid) || !this.isDeviceBusy(udid)) return;
    // `boot()` reads `idleShutdowns` (in `bootDevice`) before this entry is
    // stored and after the finished shutdown removed its own, so it sees nothing.
    const restoration: Promise<void> = this.boot(udid)
      .then((result) => {
        if (result.kind !== "booted") {
          throw new DeviceBackendError(
            "The Ryco-owned Simulator boot limit was reached while resuming device use.",
          );
        }
      })
      .finally(() => {
        if (this.idleShutdowns.get(udid) === restoration) this.idleShutdowns.delete(udid);
      });
    this.idleShutdowns.set(udid, restoration);
    await restoration;
    this.assertNotDisposed();
  }

  /**
   * Only the shutdown pending when called, for `bootDevice`. Never a newer
   * entry: that may be a restoration sharing the very boot that is waiting.
   */
  private async awaitIssuedIdleShutdown(udid: string): Promise<void> {
    const pending = this.idleShutdowns.get(udid);
    if (pending) await pending.catch(() => undefined);
  }

  private bumpDeviceGeneration(udid: string): void {
    this.deviceGenerations.set(udid, (this.deviceGenerations.get(udid) ?? 0) + 1);
  }

  private clearIdleTimer(udid: string): void {
    const timer = this.idleTimers.get(udid);
    if (!timer) return;
    this.cancel(timer);
    this.idleTimers.delete(udid);
  }

  private async snapshot(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const availability = await this.backend.availability();
    const devices = await this.discover(availability, { includeShutdown: true });
    return {
      ...(this.backend.hostSummaries ? { hosts: this.backend.hostSummaries() } : {}),
      threadId: threadId as ThreadDeviceState["threadId"],
      version: attachment.version,
      attachedDeviceUdid: attachment.attachedDeviceUdid as ThreadDeviceState["attachedDeviceUdid"],
      devices,
      agentActive: attachment.agentActiveCount > 0,
      availability,
      lastError: attachment.lastError,
      attachPhase: attachment.attachPhase,
    };
  }

  private async publish(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    attachment.version += 1;
    const state = await this.snapshot(threadId);
    this.emit({ type: "device.thread-state", state });
    return state;
  }

  /** A boot or shutdown changes the device list every open pane is showing. */
  private async publishAllThreads(): Promise<void> {
    for (const [threadId] of this.threads) await this.publish(threadId);
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One bad listener must not stop the rest from seeing device events.
      }
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof DeviceBackendError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
