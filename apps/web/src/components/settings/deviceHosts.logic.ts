import { DeviceSshHost } from "@ryco/contracts";
import { Schema } from "effect";

const isHost = Schema.is(DeviceSshHost);

/** The SSH host editor's fields, as typed. */
export interface Draft {
  readonly name: string;
  readonly target: string;
  readonly port: string;
  readonly identityFile: string;
  readonly executable: string;
}

export const EMPTY_DRAFT: Draft = {
  name: "",
  target: "",
  port: "",
  identityFile: "",
  executable: "/opt/homebrew/bin/ryco",
};

export function toDraft(host: DeviceSshHost): Draft {
  return {
    name: host.name,
    target: host.target,
    port: host.port === undefined ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    executable: host.executable,
  };
}

/** The host a draft describes, or why it is not one yet. */
export function hostFromDraft(draft: Draft): DeviceSshHost | string {
  const port = draft.port.trim();
  const host = {
    name: draft.name.trim() || draft.target.trim(),
    target: draft.target.trim(),
    executable: draft.executable.trim(),
    ...(port ? { port: Number(port) } : {}),
    ...(draft.identityFile.trim() ? { identityFile: draft.identityFile.trim() } : {}),
  };
  if (!host.target) return "Enter the SSH destination.";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,255}$/.test(host.target))
    return "Use an SSH config alias or user@hostname, without spaces.";
  if (port && !(Number.isInteger(host.port) && host.port! >= 1 && host.port! <= 65535))
    return "The port is a number from 1 to 65535.";
  if (!host.executable.startsWith("/")) return "Give the absolute path of ryco on the Mac.";
  if (host.identityFile !== undefined && !host.identityFile.startsWith("/"))
    return "The key file is an absolute path on this node.";
  return isHost(host) ? host : "Check the fields.";
}
