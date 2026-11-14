import { redirect } from "@tanstack/react-router";

import type { RootAuthGateState, RootBeforeLoadContext } from "./routes/__root";

/**
 * Whether the session may open the app's pages: a paired session, or a hosted static or Hub
 * session. Every app route's guard and the root's ready check use this one rule.
 */
export function isAppSessionGate(
  state: RootAuthGateState,
): state is Extract<
  RootAuthGateState,
  { status: "authenticated" | "hosted-static" | "hosted-hub" }
> {
  return (
    state.status === "authenticated" ||
    state.status === "hosted-static" ||
    state.status === "hosted-hub"
  );
}

/** For a route's `beforeLoad`: a session that may not open app pages goes to pairing. */
export function requireAppSession(context: RootBeforeLoadContext): void {
  if (!isAppSessionGate(context.authGateState)) {
    throw redirect({ to: "/pair", replace: true });
  }
}
