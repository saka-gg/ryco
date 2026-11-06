import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ComputerApprovedApp } from "@ryco/contracts";

/**
 * Apps the user chose "Always allow" for. The file sits next to the Computer audit log: the
 * backend reads and adds entries (only after a native dialog answer), the desktop lists and
 * removes them from settings.
 */
export const COMPUTER_APP_APPROVALS_FILE = "computer-app-approvals.json";
export const COMPUTER_APP_APPROVALS_MAX = 200;
const NAME_MAX = 128;

export function computerAppApprovalsPath(stateDir: string): string {
  return join(stateDir, COMPUTER_APP_APPROVALS_FILE);
}

/** The display name of an app identity: a path names its bundle, `.app` is dropped. */
export function computerAppDisplayName(raw: string): string {
  let name = raw.trim();
  if (name.includes("/")) name = name.replace(/\/+$/, "").split("/").pop() ?? name;
  if (name.toLowerCase().endsWith(".app")) name = name.slice(0, -4);
  return name.replace(/\s+/g, " ").slice(0, NAME_MAX);
}

/** The approval key: the display name, case-folded, so "Safari" and "safari.app" match. */
export function computerAppApprovalKey(raw: string): string {
  return computerAppDisplayName(raw).toLowerCase();
}

function decode(value: unknown): ComputerApprovedApp[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { apps?: unknown }).apps))
    return [];
  const apps: ComputerApprovedApp[] = [];
  const seen = new Set<string>();
  for (const entry of (value as { apps: unknown[] }).apps) {
    if (!entry || typeof entry !== "object") continue;
    const { key, name, allowedAt } = entry as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      typeof name !== "string" ||
      typeof allowedAt !== "string" ||
      !key ||
      key.length > NAME_MAX ||
      key !== computerAppApprovalKey(name) ||
      seen.has(key)
    )
      continue;
    seen.add(key);
    apps.push({ key, name, allowedAt });
    if (apps.length >= COMPUTER_APP_APPROVALS_MAX) break;
  }
  return apps;
}

/** A missing or unreadable file means no app is always allowed. */
export async function readComputerAppApprovals(path: string): Promise<ComputerApprovedApp[]> {
  try {
    return decode(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}

// One writer at a time per file in this process; both writers re-read before writing.
const writes = new Map<string, Promise<unknown>>();
function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
  const next = (writes.get(path) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => undefined);
  writes.set(path, settled);
  void settled.then(() => {
    if (writes.get(path) === settled) writes.delete(path);
  });
  return next;
}

async function write(path: string, apps: readonly ComputerApprovedApp[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, apps }), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function addComputerAppApproval(
  path: string,
  name: string,
  now: () => Date = () => new Date(),
): Promise<ComputerApprovedApp[]> {
  return serialized(path, async () => {
    const display = computerAppDisplayName(name);
    const key = computerAppApprovalKey(display);
    if (!key) throw new Error("An app approval needs an app name.");
    const apps = (await readComputerAppApprovals(path)).filter((app) => app.key !== key);
    apps.unshift({ key, name: display, allowedAt: now().toISOString() });
    const next = apps.slice(0, COMPUTER_APP_APPROVALS_MAX);
    await write(path, next);
    return next;
  });
}

export function removeComputerAppApproval(
  path: string,
  key: string,
): Promise<ComputerApprovedApp[]> {
  return serialized(path, async () => {
    const apps = await readComputerAppApprovals(path);
    const next = apps.filter((app) => app.key !== key);
    if (next.length !== apps.length) await write(path, next);
    return next;
  });
}
