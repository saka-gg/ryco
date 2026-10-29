// Partly adapted from pingdotgg/t3code packages/effect-codex-app-server/src/replay.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Matching recorded outbound frames against what a provider client really writes, and the
 * replay cursor that decides which recorded frames may flow back.
 *
 * - Frames are compared after a protocol normalizer drops what legitimately varies per run
 *   (package versions, paths, credentials, instruction text).
 * - Values the client generates (JSON-RPC request ids, later Claude uuids) are bound
 *   recorded→actual when a frame matches, and rewritten in the answers, so request order can
 *   change without breaking a fixture.
 * - Consecutive `expect_outbound` entries form a run that matches as a set: concurrent requests
 *   may arrive in any order. Inbound entries after a run flow once its required entries matched.
 * - `optional` entries are never waited for. They stay matchable until the end, and a recorded
 *   answer to one waits until it is actually sent.
 *
 * @module provider/testUtils/replay/replayMatch
 */
import { Schema } from "effect";

import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../../../assistantAttachments.ts";
import type { ReplayEntry, ReplayRuntimeExit } from "./replayTranscript.ts";

export type ReplayJsonPath = ReadonlyArray<string | number>;

/** A pure canonicalization applied to both the recorded and the actual outbound frame. */
export type ReplayFrameNormalizer = (frame: unknown) => unknown;

export const identityNormalizer: ReplayFrameNormalizer = (frame) => frame;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with sorted object keys at every depth. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function formatReplayJsonPath(path: ReplayJsonPath): string {
  return path.reduce<string>(
    (formatted, segment) =>
      typeof segment === "number"
        ? `${formatted}[${segment}]`
        : /^[A-Za-z_$][\w$]*$/u.test(segment)
          ? `${formatted}.${segment}`
          : `${formatted}[${JSON.stringify(segment)}]`,
    "$",
  );
}

function diffPathOf(
  expected: unknown,
  actual: unknown,
  path: ReadonlyArray<string | number>,
): ReplayJsonPath | undefined {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const nested = diffPathOf(expected[index], actual[index], [...path, index]);
      if (nested !== undefined) return nested;
    }
    return expected.length === actual.length ? undefined : [...path, length];
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
    for (const key of keys) {
      // A missing key and an explicit null are different frames (`"model": null` can clear an
      // override), as in `sameFrame`; an undefined value counts as missing, as in JSON.
      if ((expected[key] === undefined) !== (actual[key] === undefined)) return [...path, key];
      const nested = diffPathOf(expected[key], actual[key], [...path, key]);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  return stableStringify(expected) === stableStringify(actual) ? undefined : path;
}

/** The first JSON path (sorted keys, then array order) where the two values differ. */
export function firstDiffPath(expected: unknown, actual: unknown): string | undefined {
  const path = diffPathOf(expected, actual, []);
  return path === undefined ? undefined : formatReplayJsonPath(path);
}

export function readReplayJsonPath(value: unknown, path: ReplayJsonPath): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number" ? !Array.isArray(current) : !isRecord(current)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** A copy of `value` with the existing value at `path` replaced. */
export function updateReplayJsonPath(
  value: unknown,
  path: ReplayJsonPath,
  update: (current: unknown) => unknown,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return update(value);
  if (typeof head === "number" && Array.isArray(value) && head < value.length) {
    return value.map((entry, index) =>
      index === head ? updateReplayJsonPath(entry, rest, update) : entry,
    );
  }
  if (typeof head === "string" && isRecord(value) && head in value) {
    return { ...value, [head]: updateReplayJsonPath(value[head], rest, update) };
  }
  return value;
}

export function sameFrame(
  expected: unknown,
  actual: unknown,
  normalize: ReplayFrameNormalizer = identityNormalizer,
): boolean {
  return stableStringify(normalize(expected)) === stableStringify(normalize(actual));
}

/** Where client-generated values sit in a protocol's frames. */
export interface ReplayBindingRules {
  /** Paths, in a normalized outbound frame, of values the client generates. */
  readonly outbound: (frame: unknown) => ReadonlyArray<ReplayJsonPath>;
  /** Paths, in an inbound frame, whose recorded values are replaced by their bound actual. */
  readonly inbound: (frame: unknown) => ReadonlyArray<ReplayJsonPath>;
}

/**
 * JSON-RPC: the client numbers its own requests, so a request's `id` is bound and the matching
 * response's `id` rewritten. Server requests and the client's responses to them keep the
 * transcript's ids.
 */
export const jsonRpcBindingRules: ReplayBindingRules = {
  outbound: (frame) =>
    isRecord(frame) && typeof frame.method === "string" && frame.id !== undefined ? [["id"]] : [],
  inbound: (frame) =>
    isRecord(frame) && frame.method === undefined && frame.id !== undefined ? [["id"]] : [],
};

const IGNORED = "<ignored>";
const ATTACHMENT_INSTRUCTIONS_PREFIX = `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\n`;

function withParams(
  frame: Readonly<Record<string, unknown>>,
  update: (params: Readonly<Record<string, unknown>>) => Record<string, unknown>,
) {
  return isRecord(frame.params) ? { ...frame, params: update(frame.params) } : frame;
}

/**
 * Codex app-server outbound normalization:
 * - `initialize`: the client version is the package version.
 * - `thread/start` and `thread/resume`: `cwd` is per run, and `config.mcp_servers` carries
 *   device-gateway URLs and Agent Control credentials, so it is never compared or kept.
 * - `turn/start`: the developer instructions and the attachment instructions that lead a prompt
 *   without a collaboration mode change with product copy, not with the protocol.
 */
export const normalizeCodexOutbound: ReplayFrameNormalizer = (frame) => {
  if (!isRecord(frame)) return frame;
  switch (frame.method) {
    case "initialize":
      return withParams(frame, (params) =>
        isRecord(params.clientInfo)
          ? { ...params, clientInfo: { ...params.clientInfo, version: IGNORED } }
          : { ...params },
      );
    case "thread/start":
    case "thread/resume":
      return withParams(frame, ({ cwd: _cwd, ...params }) => {
        if (!isRecord(params.config)) return params;
        const config = Object.fromEntries(
          Object.entries(params.config).filter(
            ([key]) => key !== "mcp_servers" && !key.startsWith("mcp_servers."),
          ),
        );
        return { ...params, config };
      });
    case "turn/start":
      return withParams(frame, (params) => {
        const next: Record<string, unknown> = { ...params };
        if (Array.isArray(params.input)) {
          next.input = params.input.map((item: unknown) =>
            isRecord(item) &&
            item.type === "text" &&
            typeof item.text === "string" &&
            item.text.startsWith(ATTACHMENT_INSTRUCTIONS_PREFIX)
              ? {
                  ...item,
                  text: `<attachment-instructions>\n\n${item.text.slice(ATTACHMENT_INSTRUCTIONS_PREFIX.length)}`,
                }
              : item,
          );
        }
        const mode = params.collaborationMode;
        if (isRecord(mode) && isRecord(mode.settings)) {
          next.collaborationMode = {
            ...mode,
            settings: { ...mode.settings, developer_instructions: IGNORED },
          };
        }
        return next;
      });
    default:
      return frame;
  }
};

const MAX_FRAME_TEXT = 4_000;
const frameText = (frame: unknown) => {
  const text = stableStringify(frame);
  return text.length > MAX_FRAME_TEXT ? `${text.slice(0, MAX_FRAME_TEXT)}…` : text;
};
const where = (scenario: string, spawn: number) => `Replay '${scenario}' (spawn #${spawn})`;

/**
 * An outbound frame matched no expected entry. `expected` and `actual` are normalized, so
 * credentials a normalizer drops never reach the message.
 */
export class ReplayFrameMismatchError extends Schema.TaggedError<ReplayFrameMismatchError>()(
  "ReplayFrameMismatchError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
    diffPath: Schema.String,
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: outbound frame does not match entry ${this.cursor}${
      this.label === undefined ? "" : ` (${this.label})`
    } at ${this.diffPath}.\nExpected: ${frameText(this.expected)}\nActual:   ${frameText(this.actual)}`;
  }
}

/** An outbound frame arrived after every entry was used. */
export class ReplayExhaustedError extends Schema.TaggedError<ReplayExhaustedError>()(
  "ReplayExhaustedError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: transcript exhausted at entry ${this.cursor}; received ${frameText(this.actual)}`;
  }
}

/** An outbound frame arrived where the transcript allows none (after exit, or unparsable). */
export class ReplayUnexpectedOutboundError extends Schema.TaggedError<ReplayUnexpectedOutboundError>()(
  "ReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    cursor: Schema.Number,
    reason: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: unexpected outbound frame at entry ${this.cursor} (${this.reason}): ${frameText(this.actual)}`;
  }
}

/** The scenario ended with transcript entries never reached. */
export class ReplayIncompleteError extends Schema.TaggedError<ReplayIncompleteError>()(
  "ReplayIncompleteError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    cursor: Schema.Number,
    remainingLabels: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: ${this.remainingLabels.length} entries never reached, from entry ${this.cursor}: ${this.remainingLabels.join(", ")}`;
  }
}

/** The transcript recorded the provider exiting with an error or being cancelled. */
export class ReplayRuntimeExitError extends Schema.TaggedError<ReplayRuntimeExitError>()(
  "ReplayRuntimeExitError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    code: Schema.Number,
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: recorded runtime exit '${this.status}' (code ${this.code}) at entry ${this.cursor}`;
  }
}

/** The code under test started a process the transcript has no segment for. */
export class ReplayUnexpectedSpawnError extends Schema.TaggedError<ReplayUnexpectedSpawnError>()(
  "ReplayUnexpectedSpawnError",
  {
    scenario: Schema.String,
    spawn: Schema.Number,
    command: Schema.String,
  },
) {
  override get message(): string {
    return `${where(this.scenario, this.spawn)}: no transcript for spawn of '${this.command}'`;
  }
}

export type ReplayError =
  | ReplayFrameMismatchError
  | ReplayExhaustedError
  | ReplayUnexpectedOutboundError
  | ReplayIncompleteError
  | ReplayRuntimeExitError
  | ReplayUnexpectedSpawnError;

export type ReplayInboundStep =
  | {
      readonly type: "emit";
      readonly cursor: number;
      readonly label: string | undefined;
      readonly stream: "stdout" | "stderr";
      /** With bound values already rewritten. */
      readonly frame: unknown;
    }
  | {
      readonly type: "exit";
      readonly cursor: number;
      readonly status: ReplayRuntimeExit["status"];
      readonly code: number | undefined;
      readonly error: unknown;
    };

export interface ReplayCursorOptions {
  readonly scenario: string;
  /** 1-based process number, for messages. */
  readonly spawn?: number;
  readonly normalize?: ReplayFrameNormalizer;
  readonly bindings?: ReplayBindingRules;
}

/** The replay state of one process (one transcript segment, without `spawn` entries). */
export interface ReplayCursor {
  /**
   * The next inbound step allowed to flow, without taking it; undefined while the cursor waits
   * for outbound frames or after the last entry.
   */
  readonly peekInbound: () => ReplayInboundStep | undefined;
  /** Takes the step `peekInbound` returned. */
  readonly takeInbound: () => void;
  /** Matches one outbound frame; returns the failure, if it matched nothing. */
  readonly matchOutbound: (actual: unknown) => ReplayError | undefined;
  /** Labels of the entries not reached yet; optional entries and `runtime_exit` excluded. */
  readonly remainingLabels: () => ReadonlyArray<string>;
  /** Index of the next entry not yet reached. */
  readonly position: () => number;
  /** What the cursor waits for, for timeouts. */
  readonly describeWaiting: () => string;
}

/** A label for messages: the entry's own, or its type and JSON-RPC method or frame type. */
export function describeReplayEntry(entry: ReplayEntry): string {
  if ("label" in entry && entry.label !== undefined) return entry.label;
  if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry.type;
  const frame = entry.frame;
  const kind = isRecord(frame)
    ? typeof frame.method === "string"
      ? frame.method
      : frame.id !== undefined
        ? `response:${String(frame.id)}`
        : typeof frame.type === "string"
          ? frame.type
          : undefined
    : undefined;
  return kind === undefined ? entry.type : `${entry.type}:${kind}`;
}

const frameKind = (frame: unknown) =>
  isRecord(frame)
    ? typeof frame.method === "string"
      ? frame.method
      : typeof frame.type === "string"
        ? frame.type
        : undefined
    : undefined;

const BOUND = "<bound>";

export function makeReplayCursor(
  entries: ReadonlyArray<ReplayEntry>,
  options: ReplayCursorOptions,
): ReplayCursor {
  const scenario = options.scenario;
  const spawn = options.spawn ?? 1;
  const normalize = options.normalize ?? identityNormalizer;
  const rules = options.bindings ?? jsonRpcBindingRules;
  const expected = entries.map((entry) =>
    entry.type === "expect_outbound" ? normalize(entry.frame) : undefined,
  );
  const isOptional = (index: number) => {
    const entry = entries[index];
    return entry?.type === "expect_outbound" && entry.optional === true;
  };

  /** recorded value (stable JSON) → actual value. */
  const bindings = new Map<string, unknown>();
  let index = 0;
  /** Unmatched entries of the run the cursor stands at. */
  let run: Array<number> | undefined;
  /** Unmatched optional entries of earlier runs. */
  const armed: Array<number> = [];
  /** Recorded answers to armed optional requests, released when the request is matched. */
  const held = new Map<number, Array<ReplayInboundStep & { readonly type: "emit" }>>();
  const released: Array<ReplayInboundStep> = [];
  const reached = new Set<number>();
  let exited = false;

  const boundValuesOf = (entryIndex: number) =>
    rules
      .outbound(expected[entryIndex])
      .map((path) => readReplayJsonPath(expected[entryIndex], path))
      .filter((value) => value !== undefined)
      .map(stableStringify);

  const applyBindings = (frame: unknown) =>
    rules.inbound(frame).reduce<unknown>(
      (current, path) =>
        updateReplayJsonPath(current, path, (value) => {
          const key = stableStringify(value);
          return bindings.has(key) ? bindings.get(key) : value;
        }),
      frame,
    );

  /** The armed optional request a recorded inbound frame answers, if any. */
  const answeredOptional = (frame: unknown) => {
    const values = rules
      .inbound(frame)
      .map((path) => stableStringify(readReplayJsonPath(frame, path)));
    if (values.length === 0) return undefined;
    return armed.find((candidate) =>
      boundValuesOf(candidate).some((bound) => values.includes(bound)),
    );
  };

  /** Advances through everything that needs no outbound frame and emits nothing. */
  const settle = () => {
    while (true) {
      if (released.length > 0) return;
      if (run !== undefined) {
        if (run.some((candidate) => !isOptional(candidate))) return;
        armed.push(...run);
        run = undefined;
      }
      const entry = entries[index];
      if (entry === undefined || entry.type === "spawn") return;
      if (entry.type === "expect_outbound") {
        const members: Array<number> = [];
        while (entries[index]?.type === "expect_outbound") {
          members.push(index);
          reached.add(index);
          index += 1;
        }
        run = members;
        continue;
      }
      if (entry.type === "emit_inbound") {
        const optional = answeredOptional(entry.frame);
        if (optional === undefined) return;
        const heldSteps = held.get(optional) ?? [];
        heldSteps.push({
          type: "emit",
          cursor: index,
          label: entry.label,
          stream: entry.stream ?? "stdout",
          frame: entry.frame,
        });
        held.set(optional, heldSteps);
        reached.add(index);
        index += 1;
        continue;
      }
      return;
    }
  };

  const peekInbound = (): ReplayInboundStep | undefined => {
    settle();
    const releasedStep = released[0];
    if (releasedStep !== undefined) {
      return releasedStep.type === "emit"
        ? { ...releasedStep, frame: applyBindings(releasedStep.frame) }
        : releasedStep;
    }
    if (run !== undefined) return undefined;
    const entry = entries[index];
    if (entry?.type === "emit_inbound") {
      return {
        type: "emit",
        cursor: index,
        label: entry.label,
        stream: entry.stream ?? "stdout",
        frame: applyBindings(entry.frame),
      };
    }
    if (entry?.type === "runtime_exit") {
      return {
        type: "exit",
        cursor: index,
        status: entry.status,
        code: entry.code,
        error: entry.error,
      };
    }
    return undefined;
  };

  const takeInbound = () => {
    if (released.length > 0) {
      released.shift();
      return;
    }
    const entry = entries[index];
    if (run === undefined && (entry?.type === "emit_inbound" || entry?.type === "runtime_exit")) {
      if (entry.type === "runtime_exit") exited = true;
      reached.add(index);
      index += 1;
    }
  };

  const compare = (entryIndex: number, actual: unknown) => {
    let recorded = expected[entryIndex];
    let received = actual;
    const bound: Array<readonly [string, unknown]> = [];
    for (const path of rules.outbound(recorded)) {
      const recordedValue = readReplayJsonPath(recorded, path);
      const actualValue = readReplayJsonPath(received, path);
      if (recordedValue === undefined || actualValue === undefined) continue;
      bound.push([stableStringify(recordedValue), actualValue]);
      recorded = updateReplayJsonPath(recorded, path, () => BOUND);
      received = updateReplayJsonPath(received, path, () => BOUND);
    }
    const diffPath = firstDiffPath(recorded, received);
    return { diffPath, bound, recorded, received };
  };

  const matchOutbound = (actualFrame: unknown): ReplayError | undefined => {
    settle();
    const actual = normalize(actualFrame);
    const candidates = [...(run ?? []), ...armed];
    for (const candidate of candidates) {
      const result = compare(candidate, actual);
      if (result.diffPath !== undefined) continue;
      for (const [recorded, value] of result.bound) bindings.set(recorded, value);
      if (run?.includes(candidate)) run = run.filter((member) => member !== candidate);
      const armedIndex = armed.indexOf(candidate);
      if (armedIndex !== -1) armed.splice(armedIndex, 1);
      released.push(...(held.get(candidate) ?? []));
      held.delete(candidate);
      return undefined;
    }
    if (run === undefined) {
      const next = entries[index];
      if (next === undefined || next.type === "spawn") {
        return exited
          ? new ReplayUnexpectedOutboundError({
              scenario,
              spawn,
              cursor: index,
              reason: "the transcript recorded the process exiting",
              actual,
            })
          : new ReplayExhaustedError({ scenario, spawn, cursor: index, actual });
      }
      return new ReplayUnexpectedOutboundError({
        scenario,
        spawn,
        cursor: index,
        reason:
          next.type === "runtime_exit"
            ? "the transcript recorded the process exiting"
            : `${describeReplayEntry(next)} is due first`,
        actual,
      });
    }
    const kind = frameKind(actual);
    const closest = run.find((candidate) => frameKind(expected[candidate]) === kind) ?? run[0]!;
    const result = compare(closest, actual);
    const entry = entries[closest];
    return new ReplayFrameMismatchError({
      scenario,
      spawn,
      cursor: closest,
      ...(entry?.type === "expect_outbound" && entry.label !== undefined
        ? { label: entry.label }
        : {}),
      expected: result.recorded,
      actual: result.received,
      diffPath: result.diffPath ?? "$",
    });
  };

  const remainingLabels = () =>
    entries.flatMap((entry, entryIndex) => {
      if (entry.type === "runtime_exit" || entry.type === "spawn") return [];
      if (entry.type === "expect_outbound") {
        const unmatched =
          !reached.has(entryIndex) || run?.includes(entryIndex) || armed.includes(entryIndex);
        return unmatched && entry.optional !== true ? [describeReplayEntry(entry)] : [];
      }
      return reached.has(entryIndex) ? [] : [describeReplayEntry(entry)];
    });

  const describeWaiting = () => {
    if (released.length > 0) return `entry ${released[0]!.cursor}: releasing held answers`;
    const required = run?.filter((member) => !isOptional(member)) ?? [];
    if (required.length > 0) {
      return `entry ${required[0]}: waiting for outbound ${required
        .map((member) => describeReplayEntry(entries[member]!))
        .join(" | ")}`;
    }
    const entry = entries[index];
    return entry === undefined
      ? `entry ${index}: end of transcript`
      : `entry ${index}: next ${describeReplayEntry(entry)}`;
  };

  return {
    peekInbound,
    takeInbound,
    matchOutbound,
    remainingLabels,
    position: () => index,
    describeWaiting,
  };
}
