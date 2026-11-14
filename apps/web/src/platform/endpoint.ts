import type { EndpointService } from "@ryco/client-runtime/platform";

import {
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary/target";
import { isLoopbackHostname } from "@ryco/shared/loopbackHost";

export const webEndpoint: EndpointService = {
  origin: () => window.location.origin,
  readPrimaryTarget: () => readPrimaryEnvironmentTarget(),
  resolveHttpUrl: (pathname, searchParams) =>
    searchParams
      ? resolvePrimaryEnvironmentHttpUrl(pathname, { ...searchParams })
      : resolvePrimaryEnvironmentHttpUrl(pathname),
  resolveWsUrl: (wsBaseUrl) => new URL(wsBaseUrl, window.location.origin).toString(),
};

/** Browser-only dev proxy rewrite; runtime code receives already-resolved base URLs. */
export function rewriteEnvironmentHttpBaseUrlInDev(httpBaseUrl: string): string {
  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  if (!configuredDevServerUrl) return httpBaseUrl;
  const currentUrl = new URL(window.location.href);
  const targetUrl = new URL(httpBaseUrl);
  const devServerUrl = new URL(configuredDevServerUrl, currentUrl.origin);
  const isLoopback = (hostname: string) => isLoopbackHostname(hostname, { ipv4: "127.0.0.1" });
  if (
    (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") ||
    currentUrl.origin !== devServerUrl.origin ||
    currentUrl.origin === targetUrl.origin ||
    !isLoopback(currentUrl.hostname) ||
    !isLoopback(targetUrl.hostname)
  )
    return httpBaseUrl;
  return currentUrl.origin;
}
