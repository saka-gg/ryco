import { EnvironmentId, type FilesystemBrowseResult } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  connection: null as null | {
    readonly environmentId: string;
    readonly client: {
      readonly api: {
        readonly filesystem: {
          readonly browse: (input: {
            readonly partialPath: string;
          }) => Promise<FilesystemBrowseResult>;
        };
      };
    };
  },
  listeners: new Set<() => void>(),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApiForConnection: (
    _environmentId: string,
    client: NonNullable<typeof harness.connection>["client"] | null,
  ) => client?.api,
  ensureEnvironmentApi: () => {
    throw new Error("not used by filesystem browse");
  },
  readEnvironmentApi: () => {
    throw new Error("filesystem browse must use the observed connection");
  },
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    harness.connection?.environmentId === environmentId ? harness.connection : null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));

import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { resetProjectAtomsForTests } from "../rpc/projectAtoms";
import { useFilesystemBrowse } from "../rpc/useProject";
import { resolveCanonicalPrimaryEnvironmentId } from "./RootAppShell.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-hosted");
const SERVER_ENVIRONMENT_ID = EnvironmentId.make("server-environment-id");

function BrowseProbe() {
  const state = useFilesystemBrowse({
    environmentId: ENVIRONMENT_ID,
    partialPath: "~/",
  });
  return (
    <div data-testid="browse-state">
      {state.error ? state.error.message : (state.data?.parentPath ?? "pending")}
    </div>
  );
}

function HostedBrowseProbe() {
  const environmentId = resolveCanonicalPrimaryEnvironmentId({
    hosted: true,
    primaryEnvironmentId: ENVIRONMENT_ID,
    serverEnvironmentId: SERVER_ENVIRONMENT_ID,
  });
  const state = useFilesystemBrowse({
    environmentId,
    partialPath: "~/",
  });
  return (
    <div data-testid="hosted-browse-state">
      {state.error ? state.error.message : (state.data?.parentPath ?? "pending")}
    </div>
  );
}

function publishConnection(connection: typeof harness.connection): void {
  harness.connection = connection;
  for (const listener of harness.listeners) listener();
}

beforeEach(() => {
  harness.connection = null;
  harness.listeners.clear();
  resetProjectAtomsForTests();
  resetAppAtomRegistryForTests();
});

afterEach(() => {
  harness.connection = null;
  harness.listeners.clear();
  resetProjectAtomsForTests();
  resetAppAtomRegistryForTests();
});

describe("useFilesystemBrowse", () => {
  it("keeps hosted browsing on the Hub-keyed connection when the server identity differs", async () => {
    const browse = vi.fn().mockResolvedValue({
      parentPath: "~/",
      entries: [{ name: "Development", fullPath: "~/Development" }],
    });
    publishConnection({
      environmentId: ENVIRONMENT_ID,
      client: { api: { filesystem: { browse } } },
    });

    const mounted = await render(
      <AppAtomRegistryProvider>
        <HostedBrowseProbe />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByTestId("hosted-browse-state")).toMatchTextContent("~/");
    expect(browse).toHaveBeenCalledOnce();
    expect(browse).toHaveBeenCalledWith({ partialPath: "~/" });

    await mounted.unmount();
  });

  it("retries the same path when its environment connection appears", async () => {
    const browse = vi.fn().mockResolvedValue({
      parentPath: "~/",
      entries: [{ name: "Development", fullPath: "~/Development" }],
    });
    const mounted = await render(
      <AppAtomRegistryProvider>
        <BrowseProbe />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(page.getByTestId("browse-state"))
      .toMatchTextContent("temporarily unavailable");

    publishConnection({
      environmentId: ENVIRONMENT_ID,
      client: { api: { filesystem: { browse } } },
    });

    await expect.element(page.getByTestId("browse-state")).toMatchTextContent("~/");
    expect(browse).toHaveBeenCalledOnce();
    expect(browse).toHaveBeenCalledWith({ partialPath: "~/" });

    await mounted.unmount();
  });

  it("uses the exact replacement connection and ignores a superseded response", async () => {
    let resolveFirst!: (result: FilesystemBrowseResult) => void;
    const firstBrowse = vi.fn(
      () =>
        new Promise<FilesystemBrowseResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondBrowse = vi.fn().mockResolvedValue({
      parentPath: "~/replacement",
      entries: [{ name: "Current", fullPath: "~/replacement/Current" }],
    });
    const mounted = await render(
      <AppAtomRegistryProvider>
        <BrowseProbe />
      </AppAtomRegistryProvider>,
    );

    publishConnection({
      environmentId: ENVIRONMENT_ID,
      client: { api: { filesystem: { browse: firstBrowse } } },
    });
    await vi.waitFor(() => expect(firstBrowse).toHaveBeenCalledOnce());

    publishConnection({
      environmentId: ENVIRONMENT_ID,
      client: { api: { filesystem: { browse: secondBrowse } } },
    });

    await expect.element(page.getByTestId("browse-state")).toMatchTextContent("~/replacement");
    expect(secondBrowse).toHaveBeenCalledOnce();

    resolveFirst({
      parentPath: "~/superseded",
      entries: [{ name: "Old", fullPath: "~/superseded/Old" }],
    });
    await Promise.resolve();

    await expect.element(page.getByTestId("browse-state")).toMatchTextContent("~/replacement");

    await mounted.unmount();
  });
});
