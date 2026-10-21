import type { DesktopUpdateState } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resetAppAtomRegistryForTests } from "@ryco/client-runtime/rpc";
import {
  desktopUpdateStateAtom,
  getDesktopUpdateState,
  setDesktopUpdateState,
} from "./desktopUpdateAtoms";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

afterEach(() => {
  resetAppAtomRegistryForTests();
});

describe("desktopUpdateStateAtom", () => {
  it("defaults to null until a state is written", () => {
    expect(getDesktopUpdateState()).toBeNull();
  });

  it("writes desktop update state into the shared atom", () => {
    const nextState: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };

    setDesktopUpdateState(nextState);

    expect(getDesktopUpdateState()).toEqual(nextState);
  });

  it("notifies atom subscribers when the state changes", () => {
    void desktopUpdateStateAtom;
    const seen: Array<DesktopUpdateState | null> = [];
    setDesktopUpdateState(baseState);
    seen.push(getDesktopUpdateState());

    const downloaded: DesktopUpdateState = { ...baseState, status: "downloading" };
    setDesktopUpdateState(downloaded);
    seen.push(getDesktopUpdateState());

    expect(seen).toEqual([baseState, downloaded]);
  });
});
