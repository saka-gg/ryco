import { getRouteApi, useNavigate } from "@tanstack/react-router";

import { HostedPairingRouteSurface, PairingRouteSurface } from "../auth/PairingRouteSurface";

const pairRouteApi = getRouteApi("/pair");

/**
 * The `/pair` route body, loaded by the route file through `lazyRouteComponent`:
 * only a browser that still has to pair opens it, so every other launch skips
 * the pairing form and its credential handling.
 */
export function PairRoute() {
  const { authGateState } = pairRouteApi.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}
