import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type {
  EnvironmentId,
  UsageProviderKind,
  UsageSourceDeduplicationKind,
} from "@ryco/contracts";

export interface UsageSourceIdentity {
  readonly sourceId: string;
  readonly deduplicationKind: UsageSourceDeduplicationKind;
  readonly canonicalRoot: string;
}

export function makeUsageSourceId(parts: {
  readonly provider: UsageProviderKind;
  readonly canonicalRoot: string;
  readonly volumeId: string;
  readonly environmentId: EnvironmentId;
  readonly hostname?: string;
}): Pick<UsageSourceIdentity, "sourceId" | "deduplicationKind"> {
  const physical = parts.volumeId.length > 0;
  const material = physical
    ? `${parts.hostname ?? NodeOS.hostname()}\0${parts.provider}\0${parts.canonicalRoot}\0${parts.volumeId}`
    : `${parts.environmentId}\0${parts.provider}\0${parts.canonicalRoot}`;
  return {
    sourceId: createHash("sha256").update(material).digest("hex"),
    deduplicationKind: physical ? "physical" : "environment-only",
  };
}

export async function resolveUsageSourceIdentity(input: {
  readonly root: string;
  readonly provider: UsageProviderKind;
  readonly environmentId: EnvironmentId;
}): Promise<UsageSourceIdentity> {
  let canonicalRoot = input.root;
  let volumeId = "";
  try {
    canonicalRoot = await NodeFSP.realpath(input.root);
    const stat = await NodeFSP.stat(canonicalRoot);
    volumeId = `${stat.dev}:${stat.ino}`;
  } catch {
    // A missing or unreadable provider directory still receives a stable
    // environment-scoped identity for coverage reporting.
  }
  return {
    ...makeUsageSourceId({
      provider: input.provider,
      canonicalRoot,
      volumeId,
      environmentId: input.environmentId,
    }),
    canonicalRoot,
  };
}
