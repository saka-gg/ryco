/**
 * Per-task device-control consent: which `deviceControlConsent` proposal answers for a thread's
 * current task, and what the user decided. The index and the asking flow are the shared
 * per-task consent (`taskConsent.ts`), with the device's udid as the subject.
 *
 * Loaded with the `ryco_device` tool (on first use, never at boot). One instance per tool set.
 *
 * @module agentControl/deviceControlConsent
 */
import {
  TASK_CONSENT_MAX_ATTEMPTS,
  TASK_CONSENT_MAX_THREADS,
  TaskConsents,
  taskConsentRequestId,
  taskConsentStateFor,
  type TaskConsentEntry,
  type TaskConsentKey,
  type TaskConsentOutcome,
  type TaskConsentState,
} from "./taskConsent.ts";

export interface DeviceConsentKey extends TaskConsentKey {
  readonly udid: string;
}

export type DeviceConsentOutcome = TaskConsentOutcome;
export type DeviceConsentEntry = TaskConsentEntry<DeviceConsentKey>;
export type DeviceConsentState = TaskConsentState;

export const DEVICE_CONSENT_MAX_ATTEMPTS = TASK_CONSENT_MAX_ATTEMPTS;
export const DEVICE_CONSENT_MAX_THREADS = TASK_CONSENT_MAX_THREADS;
export const deviceConsentStateFor = taskConsentStateFor;

export class DeviceControlConsents extends TaskConsents<DeviceConsentKey> {
  constructor() {
    super((key) => key.udid);
  }
}

/** Deterministic per task, device and attempt; well under the 128-character request id cap. */
export const deviceConsentRequestId = (key: DeviceConsentKey, attempt: number): string =>
  taskConsentRequestId("device-consent", key, key.udid, attempt);
