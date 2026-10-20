import {
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isHostedEnvironmentSessionAdoptable } from "./state";
import type { HostedHubNode } from "./types";

const ENV = EnvironmentId.make("env-adoptable");
const UNKNOWN_ENV = EnvironmentId.make("env-unknown");

function hubNode(environmentId: EnvironmentId): HostedHubNode {
  return {
    id: `node-${environmentId}`,
    environmentId,
    label: "Node",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant-${environmentId}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
});

describe("isHostedEnvironmentSessionAdoptable", () => {
  it("adopts only the current session that accepted its own snapshot", () => {
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV));
    sessions.markConnectRequested(ENV, generation);
    sessions.transportStatus(ENV, generation, "online");
    sessions.markSessionReady(ENV, generation);
    expect(sessions.isCurrentGeneration(ENV, generation)).toBe(true);

    expect(isHostedEnvironmentSessionAdoptable(ENV)).toBe(true);
    expect(isHostedEnvironmentSessionAdoptable(UNKNOWN_ENV)).toBe(false);

    sessions.suspendAll();
    expect(sessions.read(ENV)?.suspended).toBe(true);
    expect(isHostedEnvironmentSessionAdoptable(ENV)).toBe(false);
  });
});
