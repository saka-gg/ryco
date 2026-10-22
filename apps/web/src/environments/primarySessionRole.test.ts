import { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  hosted: false,
  fetchSessionState: vi.fn(),
}));

vi.mock("../env", () => ({ isElectron: false, isHostedHubMode: () => state.hosted }));
vi.mock("./primary", () => ({ fetchSessionState: state.fetchSessionState }));

import {
  readPrimarySessionRole,
  requestPrimarySessionRole,
  resetPrimarySessionRoleForTests,
  subscribePrimarySessionRole,
} from "./primarySessionRole";

const PRIMARY = EnvironmentId.make("env-primary");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("primary session role", () => {
  beforeEach(() => {
    state.hosted = false;
    state.fetchSessionState.mockReset();
    resetPrimarySessionRoleForTests();
  });

  it("asks the node once and tells its listeners the answer", async () => {
    const answer = deferred<unknown>();
    state.fetchSessionState.mockReturnValue(answer.promise);
    const listener = vi.fn();
    const unsubscribe = subscribePrimarySessionRole(listener);

    expect(readPrimarySessionRole(PRIMARY)).toBeUndefined();
    requestPrimarySessionRole(PRIMARY);
    requestPrimarySessionRole(PRIMARY);
    expect(state.fetchSessionState).toHaveBeenCalledTimes(1);

    answer.resolve({ authenticated: true, role: "owner" });
    await vi.waitFor(() => expect(readPrimarySessionRole(PRIMARY)).toBe("owner"));
    expect(listener).toHaveBeenCalledTimes(1);
    requestPrimarySessionRole(PRIMARY);
    expect(state.fetchSessionState).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("remembers a client session as one, which is not the owner's", async () => {
    state.fetchSessionState.mockResolvedValue({ authenticated: true, role: "client" });
    requestPrimarySessionRole(PRIMARY);
    await vi.waitFor(() => expect(readPrimarySessionRole(PRIMARY)).toBe("client"));
  });

  it("asks again after a failure or before the page is signed in, never by itself", async () => {
    state.fetchSessionState.mockRejectedValueOnce(new Error("offline"));
    requestPrimarySessionRole(PRIMARY);
    await settle();
    expect(readPrimarySessionRole(PRIMARY)).toBeUndefined();
    expect(state.fetchSessionState).toHaveBeenCalledTimes(1);

    state.fetchSessionState.mockResolvedValueOnce({ authenticated: false });
    requestPrimarySessionRole(PRIMARY);
    await settle();
    expect(readPrimarySessionRole(PRIMARY)).toBeUndefined();

    state.fetchSessionState.mockResolvedValueOnce({ authenticated: true, role: "owner" });
    requestPrimarySessionRole(PRIMARY);
    await vi.waitFor(() => expect(readPrimarySessionRole(PRIMARY)).toBe("owner"));
    expect(state.fetchSessionState).toHaveBeenCalledTimes(3);
  });

  it("never asks in hosted mode, where the Hub states every role", () => {
    state.hosted = true;
    requestPrimarySessionRole(PRIMARY);
    expect(state.fetchSessionState).not.toHaveBeenCalled();
    expect(readPrimarySessionRole(PRIMARY)).toBeUndefined();
  });
});
