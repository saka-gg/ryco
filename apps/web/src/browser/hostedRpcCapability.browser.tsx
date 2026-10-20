import {
  configureHostedEnvironmentSessions,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { EnvironmentId, ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  useHostedDeliveryNotice,
  useHostedRpcCapability,
  type HostedDeliveryNoticeBinding,
  type HostedRpcCapability,
} from "../hostedHub/capabilities";
import { hostedHubStore } from "../hostedHub/state";
import { useHostedSwitchTarget, type HostedSwitchTarget } from "../hostedHub/switchTarget";
import type { HostedHubNode, HostedHubState } from "../hostedHub/types";

const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");

const dispatch = ORCHESTRATION_WS_METHODS.dispatchCommand;

function hubNode(
  environmentId: EnvironmentId,
  overrides: Partial<HostedHubNode> = {},
): HostedHubNode {
  const suffix = environmentId.slice(4);
  return {
    id: `node_${suffix}`,
    environmentId,
    label: `Node ${suffix.slice(0, 1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  };
}

/** A browser whose selection (Y) is connected and ready. */
function readyHostedState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    ...hostedHubStore.getInitialState(),
    accountStatus: "authenticated",
    directoryStatus: "ready",
    nodes: [hubNode(ENV_X), hubNode(ENV_Y)],
    selectedNode: hubNode(ENV_Y),
    selectionStatus: "online",
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionEstablished: true,
    browserStatus: "current",
    generation: 3,
    ...overrides,
  };
}

function connectRecord(
  environmentId: EnvironmentId,
  options: { readonly transport?: "online" | "connecting"; readonly ready?: boolean } = {},
) {
  const sessions = getHostedEnvironmentSessions();
  const { generation } = sessions.ensureRecord(hubNode(environmentId));
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, options.transport ?? "online");
  if (options.ready ?? true) sessions.markSessionReady(environmentId, generation);
  return generation;
}

beforeEach(() => {
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  configureHostedEnvironmentSessions({
    now: () => 0,
    setTimeout: () => null,
    clearTimeout: () => undefined,
  });
  hostedHubStore.setState(readyHostedState(), true);
});

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.unstubAllEnvs();
});

interface Probe<T> {
  readonly commits: () => number;
  readonly latest: () => T;
  readonly results: () => ReadonlyArray<T>;
}

/** Mount `useValue` and count how many times it commits and what it returned. */
async function mountProbe<T>(useValue: () => T) {
  let commits = 0;
  const results: T[] = [];
  function Component() {
    results.push(useValue());
    return null;
  }
  const mounted = await render(
    <Profiler id="probe" onRender={() => (commits += 1)}>
      <Component />
    </Profiler>,
  );
  const probe: Probe<T> = {
    commits: () => commits,
    latest: () => results[results.length - 1]!,
    results: () => results,
  };
  return { probe, unmount: () => mounted.unmount() };
}

async function patchHosted(patch: Partial<HostedHubState>) {
  await act(async () => {
    hostedHubStore.setState(patch);
  });
}

describe("useHostedRpcCapability", () => {
  it("does not re-render on hosted changes it does not read", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedRpcCapability(dispatch, null));
    try {
      expect(probe.latest()).toMatchObject({ allowed: true, kind: "ready" });
      const commits = probe.commits();
      const capability = probe.latest();

      // A directory refresh: new node objects with a later timestamp.
      await patchHosted({
        nodes: [hubNode(ENV_X, { updatedAt: 2 }), hubNode(ENV_Y, { updatedAt: 2 })],
        selectedNode: hubNode(ENV_Y, { updatedAt: 2, lastAuthenticatedAt: 9 }),
      });
      await patchHosted({ generation: 4 });
      await patchHosted({ recoveryCodes: ["code"] });
      await patchHosted({ bootstrapAvailable: true });
      expect(probe.commits()).toBe(commits);
      expect(probe.latest()).toBe(capability);
    } finally {
      await unmount();
    }
  });

  it("re-renders once when a field it reads changes, and answers from it", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedRpcCapability(dispatch, null));
    try {
      const commits = probe.commits();
      await patchHosted({ effectiveRole: "viewer" });
      expect(probe.commits()).toBe(commits + 1);
      expect(probe.latest()).toMatchObject({ allowed: false, kind: "role" });
      await patchHosted({ effectiveRole: "operator" });
      expect(probe.latest()).toMatchObject({ allowed: true, kind: "ready" });
    } finally {
      await unmount();
    }
  });

  it("is establishing during a fresh selection and allowed once it is ready", async () => {
    await patchHosted({
      transportStatus: "connecting",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "synchronizing",
    });
    const { probe, unmount } = await mountProbe(() => useHostedRpcCapability(dispatch, null));
    try {
      expect(probe.latest()).toMatchObject({ allowed: false, kind: "establishing" });
      await patchHosted({
        transportStatus: "online",
        sessionStatus: "ready",
        sessionEstablished: true,
        browserStatus: "current",
      });
      expect(probe.latest()).toMatchObject({ allowed: true, kind: "ready" });
    } finally {
      await unmount();
    }
  });

  it("follows only the record of the environment it is bound to", async () => {
    connectRecord(ENV_X, { transport: "connecting", ready: false });
    const { probe, unmount } = await mountProbe(() => useHostedRpcCapability(dispatch, ENV_X));
    try {
      expect(probe.latest()).toMatchObject({ allowed: false, kind: "establishing" });
      const commits = probe.commits();

      // Another environment's record changes: nothing re-renders.
      await act(async () => {
        connectRecord(ENV_Y);
      });
      expect(probe.commits()).toBe(commits);

      // Its own record becomes ready.
      await act(async () => {
        const sessions = getHostedEnvironmentSessions();
        const { generation } = sessions.read(ENV_X)!;
        sessions.transportStatus(ENV_X, generation, "online");
        sessions.markSessionReady(ENV_X, generation);
      });
      expect(probe.commits()).toBe(commits + 1);
      expect(probe.latest()).toMatchObject({ allowed: true, kind: "ready" });
    } finally {
      await unmount();
    }
  });

  it("gates another environment on its own session, not the selection's", async () => {
    connectRecord(ENV_X);
    await patchHosted({ transportStatus: "connecting", sessionStatus: "synchronizing" });
    const { probe, unmount } = await mountProbe(() => ({
      x: useHostedRpcCapability(dispatch, ENV_X),
      selected: useHostedRpcCapability(dispatch, null),
    }));
    try {
      expect(probe.latest().x).toMatchObject({ allowed: true, kind: "ready" });
      expect(probe.latest().selected).toMatchObject({ allowed: false, kind: "establishing" });
    } finally {
      await unmount();
    }
  });

  it("keeps its result across a re-render that changes nothing it reads", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedRpcCapability(dispatch, ENV_X));
    try {
      const first: HostedRpcCapability = probe.latest();
      await patchHosted({ nodes: [hubNode(ENV_X, { updatedAt: 5 }), hubNode(ENV_Y)] });
      expect(probe.latest()).toBe(first);
    } finally {
      await unmount();
    }
  });
});

describe("useHostedDeliveryNotice", () => {
  it("reports an unconfirmed delivery on a non-selected environment from its own record", async () => {
    const generation = connectRecord(ENV_X);
    const sessions = getHostedEnvironmentSessions();
    const { probe, unmount } = await mountProbe(() => useHostedDeliveryNotice(ENV_X));
    try {
      expect(probe.latest()).toBeNull();
      await act(async () => {
        sessions.markDeliveryUnknown(ENV_X, generation);
      });
      expect(probe.latest()).toMatchObject({ canAcknowledge: false });
      expect(probe.latest()?.description).toContain("Node x");

      await act(async () => {
        sessions.markSessionReady(ENV_X, generation);
      });
      const notice: HostedDeliveryNoticeBinding | null = probe.latest();
      expect(notice).toMatchObject({ canAcknowledge: true, actionLabel: "Continue" });

      await act(async () => {
        notice?.acknowledge();
      });
      expect(probe.latest()).toBeNull();
      expect(sessions.read(ENV_X)?.sessionStatus).toBe("ready");
    } finally {
      await unmount();
    }
  });

  it("keeps the shared session for the selected environment", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedDeliveryNotice(ENV_Y));
    try {
      expect(probe.latest()).toBeNull();
      await patchHosted({ sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true });
      expect(probe.latest()).toMatchObject({ canAcknowledge: true });
      expect(probe.latest()?.description).toContain("Node y");
    } finally {
      await unmount();
    }
  });

  it("has no notice for an environment with neither a record nor the selection", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedDeliveryNotice(ENV_X));
    try {
      await patchHosted({ sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true });
      expect(probe.latest()).toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("useHostedSwitchTarget", () => {
  it("names the target node and reports its connection phase", async () => {
    await patchHosted({ transportStatus: "connecting", sessionStatus: "synchronizing" });
    const { probe, unmount } = await mountProbe(
      (): { selected: HostedSwitchTarget; other: HostedSwitchTarget } => ({
        selected: useHostedSwitchTarget(null),
        other: useHostedSwitchTarget(ENV_X),
      }),
    );
    try {
      expect(probe.latest().selected).toEqual({
        label: "Node y",
        kind: "establishing",
        queued: false,
      });
      // X has no connection yet, but its node is online: it is on its way.
      expect(probe.latest().other).toEqual({
        label: "Node x",
        kind: "establishing",
        queued: false,
      });
    } finally {
      await unmount();
    }
  });

  it("keeps its result while nothing it reports changes", async () => {
    const { probe, unmount } = await mountProbe(() => useHostedSwitchTarget(ENV_X));
    try {
      const first = probe.latest();
      await patchHosted({ generation: 12 });
      expect(probe.latest()).toBe(first);
    } finally {
      await unmount();
    }
  });
});
