import { useComparison } from "../rpc/useComparison";
import { comparisonStorageKey } from "@ryco/client-runtime/state/comparison";
import { EnvironmentId, type GitReadComparisonResult } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { appAtomRegistry, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  values: new Map<string, string>(),
  invalidate: null as null | (() => void),
}));
vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ vcs: { readComparison: fixture.read } }),
}));
vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: () => null,
  subscribeEnvironmentConnections: () => () => {},
}));
vi.mock("../platform/kv", () => ({
  webKV: {
    getItem: async (key: string) => fixture.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      fixture.values.set(key, value);
    },
  },
}));
vi.mock("../rpc/gitAtoms", () => ({
  gitScopeKey: (cwd: string) => cwd,
  subscribeInvalidationScope: (_: string, callback: () => void) => {
    fixture.invalidate = callback;
    return () => {
      fixture.invalidate = null;
    };
  },
}));
const environmentId = EnvironmentId.make("comparison-test");
const snapshot = (oid: string): GitReadComparisonResult => ({
  selection: { ref: "main", mode: "direct" },
  patch: oid,
  source: {
    repositoryPath: "/repo/.git",
    worktreePath: "/repo",
    refOid: oid,
    headOid: "head",
    baseOid: oid,
    revision: oid,
  },
});
function View() {
  const state = useComparison({
    environmentId,
    repositoryPath: "/repo",
    cwd: "/repo",
    ignoreWhitespace: false,
    enabled: true,
  });
  return (
    <div>
      <output aria-label="Patch">{state.data?.patch ?? "empty"}</output>
      <output aria-label="Loading">{String(state.isLoading)}</output>
    </div>
  );
}
describe("comparison lifecycle adapter", () => {
  it("restores selection, revalidates mutations without blanking, and rejects disconnected-generation results", async () => {
    fixture.values.set(
      comparisonStorageKey(environmentId, "/repo"),
      JSON.stringify({ ref: "main", mode: "direct" }),
    );
    fixture.read.mockResolvedValueOnce(snapshot("initial"));
    const screen = await render(<View />);
    await expect
      .element(screen.getByRole("status", { name: "Patch" }))
      .toHaveTextContent("initial");
    let resolvePending!: (value: GitReadComparisonResult) => void;
    fixture.read.mockImplementationOnce(
      () =>
        new Promise<GitReadComparisonResult>((resolve) => {
          resolvePending = resolve;
        }),
    );
    fixture.invalidate!();
    await expect.element(screen.getByRole("status", { name: "Loading" })).toHaveTextContent("true");
    await expect
      .element(screen.getByRole("status", { name: "Patch" }))
      .toHaveTextContent("initial");
    const atom = wsConnectionStatusForEnvironmentAtom(environmentId);
    appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), phase: "disconnected" });
    resolvePending(snapshot("obsolete"));
    await expect.element(screen.getByRole("status", { name: "Patch" })).toHaveTextContent("empty");
    fixture.read.mockResolvedValueOnce(snapshot("reconnected"));
    appAtomRegistry.set(atom, {
      ...appAtomRegistry.get(atom),
      phase: "connected",
      connectedAt: "2026-09-15T00:00:00Z",
    });
    await expect
      .element(screen.getByRole("status", { name: "Patch" }))
      .toHaveTextContent("reconnected");
    await screen.unmount();
  });
});
