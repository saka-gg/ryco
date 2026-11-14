import { describe, expect, it } from "vite-plus/test";

import { isAppSessionGate, requireAppSession } from "./routeAuthGate";
import type { RootAuthGateState } from "./routes/__root";

const OPEN: ReadonlyArray<RootAuthGateState> = [
  { status: "authenticated" },
  { status: "hosted-static" },
  { status: "hosted-hub" },
];
const CLOSED: ReadonlyArray<RootAuthGateState> = [
  { status: "hosted-pairing" },
  {
    status: "requires-auth",
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "ryco_session",
    },
  },
];

describe("isAppSessionGate", () => {
  it("opens app pages for paired, hosted static and hosted Hub sessions only", () => {
    for (const state of OPEN) expect(isAppSessionGate(state), state.status).toBe(true);
    for (const state of CLOSED) expect(isAppSessionGate(state), state.status).toBe(false);
  });
});

describe("requireAppSession", () => {
  it("sends other sessions to pairing", () => {
    for (const state of OPEN) {
      expect(() => requireAppSession({ authGateState: state })).not.toThrow();
    }
    for (const state of CLOSED) {
      let thrown: unknown;
      try {
        requireAppSession({ authGateState: state });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, state.status).toMatchObject({ options: { to: "/pair", replace: true } });
    }
  });
});
