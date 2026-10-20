import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const effects = vi.hoisted(
  () => [] as Array<{ effect: () => (() => void) | undefined; deps: ReadonlyArray<unknown> }>,
);
const demand = vi.hoisted(() => {
  const release = vi.fn();
  return { release, retain: vi.fn(() => release) };
});

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined, deps: ReadonlyArray<unknown>) => {
    effects.push({ effect, deps });
  },
}));
vi.mock("@ryco/client-runtime/authorization", () => ({
  retainHostedDirectoryPresenceDemand: demand.retain,
}));

import { useDirectoryPresenceDemand } from "./directoryDemand";

beforeEach(() => {
  effects.length = 0;
  demand.retain.mockClear();
  demand.release.mockClear();
});

describe("directory presence demand", () => {
  it("holds demand while the surface is active and releases it on cleanup", () => {
    useDirectoryPresenceDemand(true);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.deps).toEqual([true]);

    const cleanup = effects[0]?.effect();
    expect(demand.retain).toHaveBeenCalledOnce();
    expect(cleanup).toBe(demand.release);
    cleanup?.();
    expect(demand.release).toHaveBeenCalledOnce();
  });

  it("holds nothing while the surface is inactive", () => {
    useDirectoryPresenceDemand(false);
    expect(effects[0]?.deps).toEqual([false]);

    expect(effects[0]?.effect()).toBeUndefined();
    expect(demand.retain).not.toHaveBeenCalled();
  });
});
