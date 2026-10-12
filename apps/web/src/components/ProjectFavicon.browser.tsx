import "../index.css";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { EnvironmentId, ProjectId, type ServerConfig } from "@ryco/contracts";
import {
  appAtomRegistry,
  serverConfigAtom,
  recordWsConnectionOpened,
  recordWsConnectionClosed,
  resetWsConnectionStateForTests,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import {
  writePrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
} from "../environments/primary";
import { createEnvironmentApiLookup } from "@ryco/client-runtime/connection";
import type { ComponentProps } from "react";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { ProjectFavicon } from "./ProjectFavicon";
import { clearProjectIconCache } from "./projectIconSource";

const envHarness = vi.hoisted(() => ({ hosted: true }));
vi.mock("../env", async (original) => ({
  ...(await original<typeof import("../env")>()),
  isHostedHubMode: () => envHarness.hosted,
}));
const connectionHarness = vi.hoisted(() => ({
  lookup: null as ReturnType<typeof createEnvironmentApiLookup> | null,
}));
vi.mock("../environmentApi", async () => {
  const { createEnvironmentApi } = await import("@ryco/client-runtime/connection");
  return {
    createEnvironmentApi,
    readEnvironmentApi: (id: EnvironmentId) => connectionHarness.lookup?.read(id),
    ensureEnvironmentApi: (id: EnvironmentId) => connectionHarness.lookup?.read(id),
    readEnvironmentApiForConnection: (_id: EnvironmentId, client: WsRpcClient | null) =>
      client ? createEnvironmentApi(client) : undefined,
  };
});
const env = EnvironmentId.make("hosted-icon-node");
const projectId = ProjectId.make("icon-project");
const descriptor = {
  environmentId: env,
  label: "Laptop",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "1",
  capabilities: {
    repositoryIdentity: true,
    threadSettlement: true,
    threadPriorityRanking: false,
    projectIcons: true,
  },
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>';
const icon = { mimeType: "image/svg+xml", dataBase64: btoa(svg) };
function connect(readIcon: unknown, supported = true) {
  writePrimaryEnvironmentDescriptor({
    ...descriptor,
    capabilities: { ...descriptor.capabilities, projectIcons: false },
  });
  appAtomRegistry.set(serverConfigAtom, {
    environment: {
      ...descriptor,
      capabilities: { ...descriptor.capabilities, projectIcons: supported },
    },
  } as ServerConfig);
  const client = {
    projects: { readIcon },
    server: {},
    filesystem: {},
    sourceControl: {},
    vcs: {},
    git: {},
    orchestration: {},
    contextHandoff: {},
    mcp: {},
    terminal: {},
  } as unknown as WsRpcClient;
  connectionHarness.lookup = createEnvironmentApiLookup({
    canReadConnections: () => true,
    readClient: () => client,
  });
  recordWsConnectionOpened({ environmentId: env });
}

describe("hosted project icons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearProjectIconCache(env);
    envHarness.hosted = true;
    connectionHarness.lookup = null;
    appAtomRegistry.set(serverConfigAtom, null);
    resetWsConnectionStateForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    document.body.innerHTML = "";
  });
  it("loads a real image from the live node despite placeholder directory capabilities", async () => {
    const read = vi.fn(async () => icon);
    connect(read);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/private/project" projectId={projectId} />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    expect(read).toHaveBeenCalledWith({ projectId });
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("img")?.src).toBe(
      `data:image/svg+xml;base64,${icon.dataBase64}`,
    );
  });
  it("ignores a late response for an earlier avatar revision", async () => {
    let complete!: (value: typeof icon) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce(icon);
    connect(read);
    const view = await render(
      <TestFavicon
        environmentId={env}
        cwd="/project"
        projectId={projectId}
        customAvatarContentHash="old"
      />,
    );
    await expect.poll(() => read.mock.calls.length).toBe(1);
    await view.rerender(
      <TestFavicon
        environmentId={env}
        cwd="/project"
        projectId={projectId}
        customAvatarContentHash="new"
      />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    complete({ ...icon, dataBase64: btoa("broken old image") });
    await expect
      .poll(() => view.container.querySelector("img")?.src)
      .toBe(`data:image/svg+xml;base64,${icon.dataBase64}`);
  });
  it("clears artwork while disconnected and restores it after reconnect without a refetch", async () => {
    const read = vi.fn(async () => icon);
    connect(read);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    recordWsConnectionClosed({}, { environmentId: env });
    await expect.poll(() => view.container.querySelector("img")).toBeNull();
    recordWsConnectionOpened({ environmentId: env });
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    // Same node, same server build: the cached artwork is reused.
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("reuses artwork after a reconnect through a new client, and on remount", async () => {
    const read = vi.fn(async () => icon);
    connect(read);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    recordWsConnectionClosed({}, { environmentId: env });
    await expect.poll(() => view.container.querySelector("img")).toBeNull();
    // A reconnect builds a new client (and API object) for the same node.
    connect(read);
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    await view.unmount();
    const remounted = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    // Cached artwork renders on the first pass.
    expect(remounted.container.querySelector("img")?.src).toBe(
      `data:image/svg+xml;base64,${icon.dataBase64}`,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("reads artwork only once the icon is near the viewport", async () => {
    const observed: Array<{ target: Element; callback: IntersectionObserverCallback }> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          observed.push({ target, callback: this.callback });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const read = vi.fn(async () => icon);
    connect(read);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    await expect.poll(() => observed.length).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
    expect(view.container.querySelector("img")).toBeNull();
    for (const { target, callback } of observed) {
      callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("shows the placeholder instead of an HTTP favicon until the node config is known", async () => {
    envHarness.hosted = false;
    const read = vi.fn(async () => icon);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} fallbackName="ryco" />,
    );
    await expect.poll(() => view.container.querySelector("svg text")?.textContent).toBe("R");
    expect(view.container.querySelector("img")).toBeNull();
    connect(read);
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("falls back without an HTTP request for unsupported hosted nodes", async () => {
    const read = vi.fn(async () => icon);
    connect(read, false);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/private/project" projectId={projectId} />,
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("shows the named fallback's initials when the project has no artwork", async () => {
    const read = vi.fn(async () => null);
    connect(read);
    const view = await render(
      <TestFavicon
        environmentId={env}
        cwd="/project"
        projectId={projectId}
        fallbackName="ryco-hub"
      />,
    );
    await expect.poll(() => read.mock.calls.length).toBe(1);
    await expect.poll(() => view.container.querySelector("svg text")?.textContent).toBe("RH");
    expect(view.container.querySelector("img")).toBeNull();
  });
  it("replaces the initials once artwork loads", async () => {
    connect(vi.fn(async () => icon));
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} fallbackName="ryco" />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    expect(view.container.querySelector("svg text")).toBeNull();
  });
  it("marks the image's load state for containers that style loaded artwork", async () => {
    let complete!: (value: typeof icon) => void;
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    connect(read);
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} fallbackName="ryco" />,
    );
    // The read starts once the icon is observed on screen.
    await expect.poll(() => read.mock.calls.length).toBe(1);
    expect(view.container.querySelector("img")).toBeNull();
    complete(icon);
    await expect
      .poll(() => view.container.querySelector<HTMLImageElement>("img")?.dataset.state)
      .toBe("loaded");
    expect(view.container.querySelector('img[data-state="loaded"]')).not.toBeNull();
  });
  it("hands the loaded artwork to onImageLoad", async () => {
    connect(vi.fn(async () => icon));
    const onImageLoad = vi.fn((image: HTMLImageElement) => image.dataset.state);
    const view = await render(
      <TestFavicon
        environmentId={env}
        cwd="/project"
        projectId={projectId}
        onImageLoad={onImageLoad}
      />,
    );
    await expect.poll(() => onImageLoad.mock.calls.length).toBe(1);
    const [image] = onImageLoad.mock.calls[0]!;
    expect(image).toBe(view.container.querySelector("img"));
    expect(image.naturalWidth).toBe(16);
  });
});

function TestFavicon(props: ComponentProps<typeof ProjectFavicon>) {
  return (
    <AppAtomRegistryProvider>
      <ProjectFavicon {...props} />
    </AppAtomRegistryProvider>
  );
}
