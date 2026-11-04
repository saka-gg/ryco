import { useEffect, useState } from "react";

import { fetchSessionState } from "~/environments/primary";

export type LocalAuthPolicy =
  | "desktop-managed-local"
  | "loopback-browser"
  | "remote-reachable"
  | "unsafe-no-auth";

/**
 * This app's own session on the backend it runs: the desktop app owns it; a
 * browser asks the backend once per mount. Null while unknown or on failure,
 * so owner tools stay hidden until the answer says owner.
 */
export function useLocalSessionAccess(): {
  readonly role: "owner" | "client" | null;
  readonly authPolicy: LocalAuthPolicy | null;
} {
  const desktop = window.desktopBridge !== undefined;
  const [session, setSession] = useState<{
    readonly role: "owner" | "client" | null;
    readonly authPolicy: LocalAuthPolicy | null;
  }>({ role: desktop ? "owner" : null, authPolicy: null });
  useEffect(() => {
    if (desktop) return;
    let cancelled = false;
    void fetchSessionState()
      .then((state) => {
        if (cancelled) return;
        setSession({
          role: state.authenticated ? (state.role ?? null) : null,
          authPolicy: state.auth.policy,
        });
      })
      .catch(() => {
        if (!cancelled) setSession({ role: null, authPolicy: null });
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);
  return session;
}
