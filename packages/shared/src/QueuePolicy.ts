export interface QueuePolicyMetricsSnapshot {
  readonly component: string;
  readonly strategy: QueuePolicy["strategy"];
  readonly capacity: number;
  readonly depth: number;
  readonly highWaterMark: number;
  readonly blockedDurationMs: number;
  readonly coalescedCount: number;
  readonly overflowCount: number;
  readonly recoveryCount: number;
}

export interface LosslessBackpressureQueuePolicy {
  readonly strategy: "lossless-backpressure";
  readonly component: string;
  readonly capacity: number;
  readonly overflow: "backpressure";
}

export interface LatestStateQueuePolicy {
  readonly strategy: "latest-state";
  readonly component: string;
  readonly capacity: number;
  readonly overflow: "backpressure-unique-keys";
  readonly recovery: "process-latest";
}

export type QueuePolicy = LosslessBackpressureQueuePolicy | LatestStateQueuePolicy;

function validCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`Queue capacity must be a positive safe integer; received ${capacity}`);
  }
  return capacity;
}

function validComponent(component: string): string {
  const normalized = component.trim();
  if (normalized.length === 0) throw new TypeError("Queue component must not be empty");
  return normalized;
}

export function losslessBackpressureQueuePolicy(input: {
  readonly component: string;
  readonly capacity: number;
}): LosslessBackpressureQueuePolicy {
  return {
    strategy: "lossless-backpressure",
    component: validComponent(input.component),
    capacity: validCapacity(input.capacity),
    overflow: "backpressure",
  };
}

export function latestStateQueuePolicy(input: {
  readonly component: string;
  readonly capacity: number;
}): LatestStateQueuePolicy {
  return {
    strategy: "latest-state",
    component: validComponent(input.component),
    capacity: validCapacity(input.capacity),
    overflow: "backpressure-unique-keys",
    recovery: "process-latest",
  };
}
