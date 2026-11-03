import "../../../index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "../overview.css";

import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  type EnvironmentApi,
  type ServerConfig,
  ThreadId,
  type ThreadLocalServer,
  type ThreadLocalServerList,
  type ThreadStopLocalServerInput,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PaneFocusContext } from "../../chat/PaneFocus";
import { useCrownServersBinding } from "../../chat/useCrownServersBinding";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../../environments/primary";
import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { crownLayoutFixture } from "./crownTestFixtures";
import type { CrownOverviewProps } from "./crownTypes";
import { CrownOverview } from "./CrownOverview";

const ENVIRONMENT = EnvironmentId.make("env-crown-servers");
const THREAD = ThreadId.make("thread-crown-servers");

const SERVER: ThreadLocalServer = {
  pid: 4321,
  startTimeMs: 1_700_000_000_000,
  port: 5173,
  host: "127.0.0.1",
  url: "http://localhost:5173/",
  processName: "node",
  pageTitle: "Thread server",
  origin: "agent",
};

function crownProps(): CrownOverviewProps {
  return {
    ...crownLayoutFixture(),
    threadTitle: "Servers",
    readiness: { remoteStatus: true, pullRequestLookup: true },
    isGitRepo: true,
    latestTurn: null,
    turnSettled: true,
    agentRunning: false,
    scopeKey: "thread-crown-servers|/repo",
    userGitActionActive: false,
  };
}

/** A node that lists servers: the test pushes lists and sees each stop it receives. */
function fakeNode(capabilities: { readonly list: boolean; readonly stop: boolean }) {
  const environment = {
    environmentId: ENVIRONMENT,
    label: "Laptop",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
      threadLocalServers: capabilities.list,
      threadLocalServerStop: capabilities.stop,
    },
  };
  writePrimaryEnvironmentDescriptor(environment);
  appAtomRegistry.set(serverConfigAtom, { environment } as ServerConfig);
  const listeners: Array<(list: ThreadLocalServerList) => void> = [];
  const subscribed: Array<string> = [];
  const stops: Array<ThreadStopLocalServerInput> = [];
  const threads: Pick<
    NonNullable<EnvironmentApi["threads"]>,
    "subscribeLocalServers" | "stopLocalServer"
  > = {
    subscribeLocalServers: ({ threadId }, listener) => {
      subscribed.push(threadId);
      listeners.push(listener);
      return () => void listeners.splice(listeners.indexOf(listener), 1);
    },
    stopLocalServer: async (input) => {
      stops.push(input);
      return { stopped: true, escalated: false };
    },
  };
  __setEnvironmentApiOverrideForTests(ENVIRONMENT, { threads } as unknown as EnvironmentApi);
  return {
    subscribed,
    stops,
    push: (servers: ReadonlyArray<ThreadLocalServer>) => {
      for (const listener of listeners.slice()) {
        listener({ threadId: THREAD, servers: [...servers], scannedAt: new Date().toISOString() });
      }
    },
  };
}

function CrownWithServers() {
  const servers = useCrownServersBinding({
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    cwd: "/repo",
    enabled: true,
    openInBrowserPanel: null,
  });
  return <CrownOverview {...crownProps()} servers={servers} />;
}

const mounts: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];

async function mountCrown() {
  const host = document.createElement("div");
  host.style.position = "relative";
  host.style.width = "1200px";
  host.style.height = "800px";
  document.body.append(host);
  const screen = await render(
    <AppAtomRegistryProvider>
      <PaneFocusContext value>
        <CrownWithServers />
      </PaneFocusContext>
    </AppAtomRegistryProvider>,
    { container: host },
  );
  mounts.push({ unmount: () => screen.unmount(), host });
  return {
    host,
    railKeys: () =>
      [...host.querySelectorAll<HTMLElement>('[data-slot="crown-rail"] [data-nav-key]')].map(
        (button) => button.dataset.navKey,
      ),
    island: () => host.querySelector<HTMLElement>('[data-slot="crown-island"]')!,
  };
}

describe("Crown Servers", () => {
  beforeEach(async () => {
    await page.viewport(1200, 800);
  });

  afterEach(async () => {
    for (const mount of mounts.splice(0).toReversed()) {
      await mount.unmount();
      mount.host.remove();
    }
    __resetEnvironmentApiOverridesForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    appAtomRegistry.set(serverConfigAtom, null);
  });

  it("follows nothing on a node that does not list servers", async () => {
    const node = fakeNode({ list: false, stop: false });
    const crown = await mountCrown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.subscribed).toEqual([]);
    expect(crown.railKeys()).not.toContain("servers");
  });

  it("hides Servers while none run, then lists one with Open and Stop", async () => {
    const node = fakeNode({ list: true, stop: true });
    const crown = await mountCrown();
    await expect.poll(() => node.subscribed).toEqual([THREAD]);
    node.push([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crown.railKeys()).not.toContain("servers");

    node.push([SERVER]);
    await expect.poll(() => crown.railKeys()).toContain("servers");
    // A status icon after Subagents, with the running count.
    expect(crown.railKeys().slice(0, 5)).toEqual([
      "changes",
      "checks",
      "plan",
      "agents",
      "servers",
    ]);
    const railButton = crown.host.querySelector<HTMLElement>(
      '[data-slot="crown-rail"] [data-nav-key="servers"]',
    )!;
    expect(railButton.querySelector(".crown-badge")?.textContent).toBe("1");
    expect(railButton.getAttribute("aria-description")).toBe("1 server running");

    await page.getByRole("button", { name: "Servers", exact: true }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("card");
    const card = page.getByRole("region", { name: "Servers" });
    await expect.element(card).toBeVisible();
    await expect.element(card.getByText("Thread server")).toBeVisible();
    await expect.element(card.getByText("localhost:5173")).toBeVisible();
    await expect.element(card.getByText("· Agent")).toBeVisible();
    await expect
      .element(card.getByRole("button", { name: "Open Thread server in your browser" }))
      .toBeVisible();

    await card.getByRole("button", { name: "Stop Thread server" }).click();
    await expect
      .poll(() => node.stops)
      .toEqual([
        { threadId: THREAD, pid: SERVER.pid, startTimeMs: SERVER.startTimeMs, port: SERVER.port },
      ]);

    // The server leaving hides the section again.
    node.push([]);
    await expect.poll(() => crown.railKeys()).not.toContain("servers");
  });

  it("offers no Stop on a node that cannot stop servers", async () => {
    const node = fakeNode({ list: true, stop: false });
    const crown = await mountCrown();
    await expect.poll(() => node.subscribed).toEqual([THREAD]);
    node.push([SERVER]);
    await expect.poll(() => crown.railKeys()).toContain("servers");
    await page.getByRole("button", { name: "Servers", exact: true }).click();
    const card = page.getByRole("region", { name: "Servers" });
    await expect.element(card.getByText("Thread server")).toBeVisible();
    expect(crown.host.querySelector('[data-testid="crown-server-stop"]')).toBeNull();
  });
});
