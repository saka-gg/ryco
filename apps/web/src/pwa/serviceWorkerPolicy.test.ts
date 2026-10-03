import { describe, expect, it } from "vite-plus/test";
import {
  ACCOUNT_E2EE_DEVICES_PATH,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
} from "@ryco/contracts/native-e2ee";

import {
  classifyServiceWorkerRequest,
  HOSTED_E2EE_NETWORK_ONLY_PATHS,
} from "./serviceWorkerPolicy";

const origin = "https://ryco.example";
const precacheUrls = new Set([
  `${origin}/assets/main-AbCd1234.js`,
  `${origin}/assets/main-EfGh5678.css`,
  `${origin}/offline.html`,
]);

function classify(input: {
  readonly url: string;
  readonly method?: string;
  readonly mode?: string;
  readonly headers?: Readonly<Record<string, string>>;
}) {
  return classifyServiceWorkerRequest({
    origin,
    precacheUrls,
    request: {
      method: input.method ?? "GET",
      mode: input.mode ?? "cors",
      headers: input.headers ?? {},
      url: input.url,
    },
  });
}

describe("hosted PWA service-worker request policy", () => {
  it("serves exact immutable allowlist matches from the shell cache", () => {
    expect(classify({ url: `${origin}/assets/main-AbCd1234.js` })).toBe("precache");
  });

  it("uses the static boot document only for same-origin document navigation", () => {
    expect(classify({ url: `${origin}/thread/1`, mode: "navigate" })).toBe("navigation");
  });

  it.each([
    ["unknown same-origin GET", { url: `${origin}/unknown.js` }],
    ["cross-origin GET", { url: "https://cdn.example/main-AbCd1234.js" }],
    ["non-GET", { url: `${origin}/assets/main-AbCd1234.js`, method: "POST" }],
    [
      "range request",
      { url: `${origin}/assets/main-AbCd1234.js`, headers: { range: "bytes=0-10" } },
    ],
    ["authentication API", { url: `${origin}/api/auth/session` }],
    ["generic API", { url: `${origin}/api/projects` }],
    ["attachment", { url: `${origin}/attachments/example` }],
    ["well-known", { url: `${origin}/.well-known/ryco` }],
    ["relay", { url: `${origin}/v1/relay/client` }],
    ["WebSocket", { url: "wss://ryco.example/v1/relay/client" }],
    ["event stream", { url: `${origin}/events`, headers: { accept: "text/event-stream" } }],
  ])("keeps %s network-only", (_label, request) => {
    expect(classify(request)).toBe("network-only");
  });

  it("checks dynamic exclusions before navigation fallback", () => {
    expect(classify({ url: `${origin}/api/auth/session`, mode: "navigate" })).toBe("network-only");
  });

  it("keeps native enrollment, grant, ticket, and device-management routes out of caches", () => {
    expect(HOSTED_E2EE_NETWORK_ONLY_PATHS).toEqual([
      NATIVE_E2EE_CURRENT_DEVICE_PATH,
      NATIVE_E2EE_GRANT_KEYS_PATH,
      NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
      ACCOUNT_E2EE_DEVICES_PATH,
    ]);
    for (const path of [
      ...HOSTED_E2EE_NETWORK_ONLY_PATHS,
      `${ACCOUNT_E2EE_DEVICES_PATH}/enr_example/rename`,
      `${ACCOUNT_E2EE_DEVICES_PATH}/enr_example/revoke`,
    ]) {
      expect(classify({ url: `${origin}${path}`, mode: "navigate" }), path).toBe("network-only");
    }
  });
});
