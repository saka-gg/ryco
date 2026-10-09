/**
 * TerminalActivity - what a terminal's diagnostics say about moving or removing its folder.
 *
 * Folder lifecycle work (removing a checkout, moving a chat into a project) closes idle shells,
 * keeping their history, and waits for a terminal that runs a command.
 *
 * @module TerminalActivity
 */
import type { DiagnosticsTerminalProcess } from "@ryco/contracts";

/** The terminal still has a shell process, or one is starting. */
export const isTerminalAlive = (
  terminal: Pick<DiagnosticsTerminalProcess, "pid" | "status">,
): boolean =>
  terminal.pid !== null || terminal.status === "running" || terminal.status === "starting";

/** The terminal runs a command beyond its idle shell, or is still starting: closing it loses work. */
export const isTerminalWorking = (
  terminal: Pick<DiagnosticsTerminalProcess, "hasRunningSubprocess" | "status">,
): boolean => terminal.hasRunningSubprocess || terminal.status === "starting";
