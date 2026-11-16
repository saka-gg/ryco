/**
 * Shape check for a challenge the Hub issues for a node to sign: the relay authentication
 * challenge (`HubNodeProofClient`) and the key-rotation challenge (`HubKeyRotationClient`).
 *
 * `challengeExpiresAt` is stamped by the Hub's clock and only the Hub enforces it, so it is
 * deliberately not compared with this machine's clock: a node whose clock runs more than the
 * challenge's lifetime ahead of (or behind) the Hub's would refuse every challenge and could never
 * authenticate or rotate its key. How long the node may take to answer is measured on the local
 * clock from the request instead (see `CHALLENGE_SIGNING_BUDGET_MS`).
 */
export function isWellFormedHubChallenge(value: {
  readonly challenge: unknown;
  readonly challengeExpiresAt: number;
}): boolean {
  return (
    value.challenge instanceof Uint8Array &&
    value.challenge.byteLength === 32 &&
    Number.isSafeInteger(value.challengeExpiresAt) &&
    value.challengeExpiresAt > 0
  );
}
