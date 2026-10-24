import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() !== url.toString()) {
    // Keep the router's entry state: without its index, back from the first
    // page would leave the app.
    window.history.replaceState(window.history.state, document.title, next.toString());
  }
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (token) stripPairingTokenFromUrl();
  return token;
}
