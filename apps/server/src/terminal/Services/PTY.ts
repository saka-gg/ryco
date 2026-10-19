/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import { Effect, Schema, Context } from "effect";

/**
 * PtyError - Error type for PTY adapter operations.
 */
export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
  /**
   * Name of the process in the foreground of the session's terminal, when the platform can
   * tell. Cheap to read and never throws; `undefined` when it cannot be determined. It is
   * not proof that nothing else runs: a shell with a background job, or a program that goes
   * by the shell's name, shows as the shell.
   */
  readonly foregroundProcessName?: () => string | undefined;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapterShape - Service API for spawning and controlling PTY processes.
 */
export interface PtyAdapterShape {
  /**
   * Spawn a PTY process for a terminal session.
   */
  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError>;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends Context.Service<PtyAdapter, PtyAdapterShape>()(
  "ryco/terminal/Services/PTY/PtyAdapter",
) {}
