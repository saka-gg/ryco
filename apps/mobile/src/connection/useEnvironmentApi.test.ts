import { EnvironmentId } from "@ryco/contracts";
import { readThreadForkApi } from "@ryco/client-runtime/state/threads";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The hook over the real api lookup and a stand-in supervisor, with React's
// external-store hook reduced to "subscribe once, read the snapshot per render".
// What it proves: an api read before the node's connection registered is not
// kept — the registration notifies the hook, and the next render reads it.

const hoisted = vi.hoisted(() => ({
  connections: new Map<string, { readonly client: unknown }>(),
  listeners: new Set<() => void>(),
  subscribe: null as ((listener: () => void) => () => void) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useSyncExternalStore: <T>(subscribe: (listener: () => void) => () => void, read: () => T) => {
    hoisted.subscribe = subscribe;
    return read();
  },
}));
vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    driver: {
      supervisor: {
        read: (environmentId: string) => hoisted.connections.get(environmentId) ?? null,
        subscribe: (listener: () => void) => {
          hoisted.listeners.add(listener);
          return () => hoisted.listeners.delete(listener);
        },
      },
    },
  }),
}));
vi.mock("../state/environmentServerConfigs", () => ({ patchEnvironmentServerSettings: () => {} }));

import { useEnvironmentApi } from "./useEnvironmentApi";

const ENVIRONMENT = EnvironmentId.make("env-api-hook");

/** A live client answering every RPC family, so the facade exposes `threads.fork`. */
function fakeClient(): unknown {
  const handler: ProxyHandler<() => void> = {
    get: (_target, key) => (key === "then" ? undefined : proxy),
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

function register(client: unknown): void {
  hoisted.connections.set(ENVIRONMENT, { client });
  for (const listener of hoisted.listeners) listener();
}

beforeEach(() => {
  hoisted.connections.clear();
  hoisted.listeners.clear();
  hoisted.subscribe = null;
});

describe("useEnvironmentApi", () => {
  it("offers the api once the connection registers after the first render", () => {
    expect(useEnvironmentApi(ENVIRONMENT)).toBeUndefined();
    const onChange = vi.fn();
    const unsubscribe = hoisted.subscribe!(onChange);

    register(fakeClient());

    expect(onChange).toHaveBeenCalledOnce();
    expect(readThreadForkApi(useEnvironmentApi(ENVIRONMENT))).not.toBeNull();
    unsubscribe();
  });

  it("keeps one api per connection and follows a replaced connection", () => {
    register(fakeClient());
    const first = useEnvironmentApi(ENVIRONMENT);
    // The snapshot is stable while the connection is: no re-render loop.
    expect(useEnvironmentApi(ENVIRONMENT)).toBe(first);

    register(fakeClient());

    const second = useEnvironmentApi(ENVIRONMENT);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    hoisted.connections.delete(ENVIRONMENT);
    expect(useEnvironmentApi(ENVIRONMENT)).toBeUndefined();
  });
});
