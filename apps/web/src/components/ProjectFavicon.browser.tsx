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
import { Profiler, type ComponentProps } from "react";
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
  it("keeps cached artwork on a row mounted from the cache after the entry is evicted or expires", async () => {
    const read = vi.fn(async () => icon);
    connect(read);
    const dataUrl = `data:image/svg+xml;base64,${icon.dataBase64}`;
    const first = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    await expect.poll(() => first.container.querySelector("img")?.naturalWidth).toBe(16);
    // A later surface for the same project renders from the cache.
    const second = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} className="a" />,
    );
    expect(second.container.querySelector("img")?.src).toBe(dataUrl);
    await first.unmount();

    // The entry is evicted: the render-time cache read now misses, but the
    // artwork the row already shows must stay.
    clearProjectIconCache(env);
    await second.rerender(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} className="b" />,
    );
    expect(second.container.querySelector("img")?.src).toBe(dataUrl);

    // The same once a fresh entry has expired.
    const third = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} className="c" />,
    );
    await expect.poll(() => third.container.querySelector("img")?.src).toBe(dataUrl);
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow + 5 * 60_000 + 1);
    try {
      await second.rerender(
        <TestFavicon environmentId={env} cwd="/project" projectId={projectId} className="d" />,
      );
      expect(second.container.querySelector("img")?.src).toBe(dataUrl);
      // Neither re-render asks the node again.
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("revalidates an expired entry when its read runs again, keeping the artwork meanwhile", async () => {
    let complete!: (value: typeof icon) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(icon)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    connect(read);
    const dataUrl = `data:image/svg+xml;base64,${icon.dataBase64}`;
    const view = await render(
      <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow + 5 * 60_000 + 1);
    try {
      // A reconnect hands the row a new API: the expired entry is read again.
      recordWsConnectionClosed({}, { environmentId: env });
      await expect.poll(() => view.container.querySelector("img")).toBeNull();
      connect(read);
      await expect.poll(() => read.mock.calls.length).toBe(2);
      // While the node answers, the latched artwork stays on screen.
      expect(view.container.querySelector("img")?.src).toBe(dataUrl);
      const updated = { ...icon, dataBase64: btoa(svg.replace("red", "blue")) };
      complete(updated);
      await expect
        .poll(() => view.container.querySelector("img")?.src)
        .toBe(`data:image/svg+xml;base64,${updated.dataBase64}`);
    } finally {
      now.mockRestore();
    }
  });

  it("asks again later when the node could not answer, without caching an absence", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("Project icon unavailable"))
      .mockResolvedValueOnce(icon);
    connect(read);
    try {
      const view = await render(
        <TestFavicon
          environmentId={env}
          cwd="/project"
          projectId={projectId}
          fallbackName="ryco"
        />,
      );
      await expect.poll(() => read.mock.calls.length).toBe(1);
      await expect.poll(() => view.container.querySelector("svg text")?.textContent).toBe("R");
      const retry = await vi.waitFor(() => {
        const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 60_000);
        if (!call) throw new Error("no retry scheduled");
        return call[0] as () => void;
      });
      retry();
      await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("stops asking after a bounded number of retries when the node never answers", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const read = vi.fn(async () => {
      throw new Error("Project icon unavailable");
    });
    connect(read);
    const retryDelays = [60_000, 120_000, 240_000];
    const retryCalls = () =>
      setTimeoutSpy.mock.calls.filter(([, delay]) => retryDelays.includes(delay ?? 0));
    try {
      const view = await render(
        <TestFavicon environmentId={env} cwd="/project" projectId={projectId} />,
      );
      await expect.poll(() => read.mock.calls.length).toBe(1);
      for (const [index, delay] of retryDelays.entries()) {
        // Each retry waits longer than the one before.
        const retry = await vi.waitFor(() => {
          const call = retryCalls()[index];
          if (!call) throw new Error("no retry scheduled");
          return call;
        });
        expect(retry[1]).toBe(delay);
        (retry[0] as () => void)();
        await expect.poll(() => read.mock.calls.length).toBe(index + 2);
      }
      // The last retry failed too: nothing further is scheduled.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(retryCalls()).toHaveLength(retryDelays.length);
      expect(read).toHaveBeenCalledTimes(retryDelays.length + 1);
      expect(view.container.querySelector("img")).toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not re-render on config pushes that keep the icon capability", async () => {
    connect(vi.fn(async () => icon));
    const renders = vi.fn();
    const view = await render(
      <AppAtomRegistryProvider>
        <Profiler id="favicon" onRender={renders}>
          <ProjectFavicon environmentId={env} cwd="/project" projectId={projectId} />
        </Profiler>
      </AppAtomRegistryProvider>,
    );
    await expect.poll(() => view.container.querySelector("img")?.naturalWidth).toBe(16);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = renders.mock.calls.length;
    const current = appAtomRegistry.get(serverConfigAtom)!;
    appAtomRegistry.set(serverConfigAtom, { ...current, providers: [] } as ServerConfig);
    appAtomRegistry.set(serverConfigAtom, { ...current } as ServerConfig);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renders).toHaveBeenCalledTimes(settled);
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
