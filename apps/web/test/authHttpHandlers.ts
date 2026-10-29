import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ServerAuthDescriptor,
} from "@ryco/contracts";
import { HttpResponse, http } from "msw";

const TEST_SESSION_EXPIRES_AT = "2026-05-01T12:00:00.000Z";
const TEST_WS_TOKEN_EXPIRES_AT = "2026-05-01T12:05:00.000Z";
const TEST_ENVIRONMENT_DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    threadSettlement: false,
    threadPriorityRanking: false,
  },
};

export function createAuthenticatedSessionHandlers(getAuthDescriptor: () => ServerAuthDescriptor) {
  return [
    http.get("*/.well-known/ryco/environment", () =>
      HttpResponse.json(TEST_ENVIRONMENT_DESCRIPTOR),
    ),
    http.get("*/api/auth/session", () =>
      HttpResponse.json({
        authenticated: true,
        auth: getAuthDescriptor(),
        sessionMethod: "browser-session-cookie",
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
    http.post("*/api/auth/bootstrap", () =>
      HttpResponse.json({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
    http.post("*/api/auth/ws-token", () =>
      HttpResponse.json({
        token: "test-ws-token",
        expiresAt: TEST_WS_TOKEN_EXPIRES_AT,
      }),
    ),
  ] as const;
}
