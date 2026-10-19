import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The favicon under a minimal hook runtime (state slots, memo slots and
// dependency-checked effects; no React renderer exists in this suite). What it
// proves: a row that first showed artwork from the shared cache keeps it once
// the cache entry expires or is dropped, a disconnected row keeps its artwork
// (and a row mounted while disconnected shows the cached one), and a reconnect
// shows the kept artwork while it reads it again.

const hoisted = vi.hoisted(() => ({
  phase: "connected" as string,
  api: undefined as unknown,
  runtime: {
    slots: [] as unknown[],
    index: 0,
    memos: [] as Array<{ deps: ReadonlyArray<unknown>; value: unknown } | undefined>,
    memoIndex: 0,
    effects: [] as Array<{ deps: ReadonlyArray<unknown>; cleanup?: () => void } | undefined>,
    effectIndex: 0,
    pending: [] as Array<() => void>,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { runtime } = hoisted;
  const same = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) =>
    left.every((dep, index) => Object.is(dep, right[index]));
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const slot = runtime.index++;
      if (!(slot in runtime.slots)) {
        runtime.slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((current: T) => T)) => {
        runtime.slots[slot] =
          typeof next === "function" ? (next as (current: T) => T)(runtime.slots[slot] as T) : next;
      };
      return [runtime.slots[slot] as T, set] as const;
    },
    useMemo: <T,>(create: () => T, deps: ReadonlyArray<unknown>) => {
      const slot = runtime.memoIndex++;
      const previous = runtime.memos[slot];
      if (previous && same(deps, previous.deps)) return previous.value as T;
      const value = create();
      runtime.memos[slot] = { deps, value };
      return value;
    },
    useEffect: (effect: () => (() => void) | void, deps: ReadonlyArray<unknown>) => {
      const slot = runtime.effectIndex++;
      const previous = runtime.effects[slot];
      if (previous && same(deps, previous.deps)) return;
      runtime.pending.push(() => {
        previous?.cleanup?.();
        runtime.effects[slot] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("./AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
vi.mock("../connection/useEnvironmentApi", () => ({ useEnvironmentApi: () => hoisted.api }));
vi.mock("../rpc/wsConnectionState", () => ({
  useWsConnectionStatusForEnvironment: () => ({ phase: hoisted.phase }),
}));
vi.mock("../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () =>
    new Map([[ENVIRONMENT, { environment: { capabilities: { projectIcons: true } } }]]),
}));

import {
  clearAllProjectIconCaches,
  clearProjectIconCache,
  PROJECT_ICON_TTL_MS,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { EnvironmentId, ProjectId, type EnvironmentApi } from "@ryco/contracts";

import { ProjectFavicon } from "./ProjectFavicon";

const ENVIRONMENT = EnvironmentId.make("favicon-node");
const PROJECT = ProjectId.make("favicon-project");
const FIRST_ICON = "data:image/png;base64,Zmlyc3Q=";
const SECOND_ICON = "data:image/png;base64,c2Vjb25k";

function makeApi(dataBase64: string) {
  const readIcon = vi.fn(async () => ({ mimeType: "image/png", dataBase64 }));
  return { api: { projects: { readIcon } } as unknown as EnvironmentApi, readIcon };
}

/** One render pass, then its effects, as a commit would run them. */
function render(): string | null {
  const { runtime } = hoisted;
  runtime.index = 0;
  runtime.memoIndex = 0;
  runtime.effectIndex = 0;
  const element = ProjectFavicon({
    environmentId: ENVIRONMENT,
    projectId: PROJECT,
    projectTitle: "Favicon project",
  }) as ReactElement<{ faviconUrl: string | null }>;
  const effects = runtime.pending.splice(0);
  for (const effect of effects) effect();
  return element.props.faviconUrl;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z"));
  hoisted.phase = "connected";
  hoisted.runtime.slots = [];
  hoisted.runtime.memos = [];
  hoisted.runtime.effects = [];
  hoisted.runtime.pending = [];
});

afterEach(() => {
  vi.useRealTimers();
  clearAllProjectIconCaches();
});

describe("ProjectFavicon", () => {
  it("keeps artwork it first showed from the cache once the entry expires or is dropped", async () => {
    // Another row already read the icon; this one mounts on the cached pass.
    const { api, readIcon } = makeApi("Zmlyc3Q=");
    hoisted.api = api;
    await readProjectIconSource(api, ENVIRONMENT, PROJECT, null);
    expect(readIcon).toHaveBeenCalledOnce();

    expect(render()).toBe(FIRST_ICON);

    vi.setSystemTime(Date.now() + PROJECT_ICON_TTL_MS + 1);
    expect(render()).toBe(FIRST_ICON);

    clearProjectIconCache(ENVIRONMENT);
    expect(render()).toBe(FIRST_ICON);
    // Nothing about the row changed, so nothing is read again.
    expect(readIcon).toHaveBeenCalledOnce();
  });

  it("keeps artwork while disconnected and while a reconnect rereads it", async () => {
    const first = makeApi("Zmlyc3Q=");
    hoisted.api = first.api;
    expect(render()).toBeNull();
    await vi.waitFor(() => expect(render()).toBe(FIRST_ICON));

    hoisted.phase = "connecting";
    expect(render()).toBe(FIRST_ICON);

    // The entry went stale while the node was away; the new connection rereads
    // it, and the kept artwork stays up until the answer replaces it.
    vi.setSystemTime(Date.now() + PROJECT_ICON_TTL_MS + 1);
    const second = makeApi("c2Vjb25k");
    hoisted.api = second.api;
    hoisted.phase = "connected";
    expect(render()).toBe(FIRST_ICON);
    expect(second.readIcon).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(render()).toBe(SECOND_ICON));
  });

  it("shows cached artwork on a row mounted while its node is not connected", async () => {
    // The Hub connects one node at a time: this node's icon was read while it
    // was connected, and a row mounts after the Hub moved to another node.
    const { api, readIcon } = makeApi("Zmlyc3Q=");
    await readProjectIconSource(api, ENVIRONMENT, PROJECT, null);
    hoisted.api = undefined;
    hoisted.phase = "disconnected";
    vi.setSystemTime(Date.now() + PROJECT_ICON_TTL_MS + 1);

    expect(render()).toBe(FIRST_ICON);
    expect(readIcon).toHaveBeenCalledOnce();
  });
});
