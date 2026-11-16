import { resolveRemotePairingTarget } from "../../connection/remoteApi";
import { getMobileEndpoint } from "../../connection/runtimeConfig";
import type { ResolvedPairingTarget } from "../../connection/environmentActions";
import { buildPairingUrl, extractPairingToken } from "./pairing";

const PAIRING_BASE_ORIGIN_FALLBACK = "https://app.ryco.space";

// App-level pairing-target resolver wired into environmentActions. Direct-node
// only: hosted pairing is C-gated (readHostedPairingRequest -> null). Accepts a
// pairing URL or host+code (folded into a URL first).
export function resolveAppPairingTarget(input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedPairingTarget {
  const pairingUrl =
    input.pairingUrl?.trim() ||
    (input.host ? buildPairingUrl(input.host, input.pairingCode ?? "") : "");
  const baseOrigin = getMobileEndpoint().origin() || PAIRING_BASE_ORIGIN_FALLBACK;
  const target = resolveRemotePairingTarget({ pairingUrl }, baseOrigin, {
    readPairingToken: (url) => extractPairingToken(url.toString()),
    readHostedPairingRequest: () => null,
  });
  return {
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    credential: target.credential,
  };
}
