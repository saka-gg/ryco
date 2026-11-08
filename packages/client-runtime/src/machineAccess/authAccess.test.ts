import { AuthSessionId, type AuthAccessStreamEvent } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ServerClientSessionRecord } from "../connection/primaryAuth.ts";
import {
  applyAuthAccessEvent,
  clientSessionDetail,
  clientSessionIsLive,
  clientSessionPrimaryLabel,
  EMPTY_AUTH_ACCESS_LIST,
  pairingLinkCanShare,
  pairingLinkPrimaryLabel,
  sortClientSessions,
} from "./authAccess.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function wireSession(
  sessionId: string,
  overrides: Partial<{
    readonly current: boolean;
    readonly connected: boolean;
    readonly issuedAt: string;
  }> = {},
) {
  return {
    sessionId: AuthSessionId.make(sessionId),
    subject: `subject-${sessionId}`,
    role: "client" as const,
    method: "bearer-session-token" as const,
    client: { deviceType: "mobile" as const, os: "iOS" },
    issuedAt: at(overrides.issuedAt ?? "2036-04-07T10:00:00.000Z"),
    expiresAt: at("2037-04-07T10:00:00.000Z"),
    lastConnectedAt: null,
    connected: overrides.connected ?? false,
    current: overrides.current ?? false,
  };
}

function wireLink(id: string, createdAt: string, role: "owner" | "client" = "client") {
  return {
    id,
    credential: `credential-${id}`,
    role,
    subject: "pairing",
    createdAt: at(createdAt),
    expiresAt: at("2036-04-07T11:00:00.000Z"),
  };
}

function event<T extends AuthAccessStreamEvent["type"]>(
  type: T,
  payload: Extract<AuthAccessStreamEvent, { type: T }>["payload"],
): AuthAccessStreamEvent {
  return { version: 1, revision: 1, type, payload } as AuthAccessStreamEvent;
}

describe("applyAuthAccessEvent", () => {
  it("replaces the list with a snapshot, sorted and with ISO instants", () => {
    const list = applyAuthAccessEvent(
      EMPTY_AUTH_ACCESS_LIST,
      event("snapshot", {
        pairingLinks: [
          wireLink("old", "2036-04-07T09:00:00.000Z"),
          wireLink("new", "2036-04-07T10:00:00.000Z"),
        ],
        clientSessions: [
          wireSession("idle"),
          wireSession("live", { connected: true }),
          wireSession("me", { current: true }),
        ],
      }),
    );
    expect(list.pairingLinks.map((link) => link.id)).toEqual(["new", "old"]);
    expect(list.pairingLinks[0]?.createdAt).toBe("2036-04-07T10:00:00.000Z");
    expect(list.clientSessions.map((session) => session.sessionId)).toEqual(["me", "live", "idle"]);
  });

  it("upserts and removes single rows without touching the other list", () => {
    let list = applyAuthAccessEvent(
      EMPTY_AUTH_ACCESS_LIST,
      event("snapshot", {
        pairingLinks: [wireLink("a", "2036-04-07T09:00:00.000Z")],
        clientSessions: [wireSession("one")],
      }),
    );
    const sessions = list.clientSessions;
    list = applyAuthAccessEvent(
      list,
      event("pairingLinkUpserted", wireLink("b", "2036-04-07T10:00:00.000Z")),
    );
    expect(list.pairingLinks.map((link) => link.id)).toEqual(["b", "a"]);
    expect(list.clientSessions).toBe(sessions);

    list = applyAuthAccessEvent(list, event("pairingLinkRemoved", { id: "a" }));
    expect(list.pairingLinks.map((link) => link.id)).toEqual(["b"]);

    list = applyAuthAccessEvent(
      list,
      event("clientUpserted", wireSession("one", { connected: true })),
    );
    expect(list.clientSessions).toHaveLength(1);
    expect(list.clientSessions[0]?.connected).toBe(true);

    list = applyAuthAccessEvent(
      list,
      event("clientRemoved", { sessionId: AuthSessionId.make("one") }),
    );
    expect(list.clientSessions).toEqual([]);
  });
});

function session(overrides: Partial<ServerClientSessionRecord>): ServerClientSessionRecord {
  return {
    sessionId: AuthSessionId.make("session"),
    subject: "subject-1",
    role: "client",
    method: "bearer-session-token",
    client: { deviceType: "unknown" },
    issuedAt: "2036-04-07T10:00:00.000Z",
    expiresAt: "2037-04-07T10:00:00.000Z",
    lastConnectedAt: null,
    connected: false,
    current: false,
    ...overrides,
  };
}

describe("row wording", () => {
  it("names a client by its label, then its OS and browser, then its subject", () => {
    expect(
      clientSessionPrimaryLabel(session({ client: { deviceType: "mobile", label: "Phone" } })),
    ).toBe("Phone");
    expect(
      clientSessionPrimaryLabel(
        session({ client: { deviceType: "desktop", os: "macOS", browser: "Safari" } }),
      ),
    ).toBe("macOS · Safari");
    expect(clientSessionPrimaryLabel(session({}))).toBe("subject-1");
  });

  it("describes a client with what the node knows about it", () => {
    expect(
      clientSessionDetail(
        session({
          role: "owner",
          client: { deviceType: "mobile", os: "iOS", ipAddress: "192.168.1.9" },
        }),
      ),
    ).toBe("Owner · Mobile · iOS · 192.168.1.9");
    expect(clientSessionDetail(session({}))).toBe("Client");
  });

  it("counts this client as live", () => {
    expect(clientSessionIsLive(session({ current: true }))).toBe(true);
    expect(clientSessionIsLive(session({ connected: true }))).toBe(true);
    expect(clientSessionIsLive(session({}))).toBe(false);
  });

  it("never shares an owner link, and labels links by role", () => {
    const owner = {
      id: "o",
      credential: "c",
      role: "owner" as const,
      subject: "s",
      createdAt: "2036-04-07T10:00:00.000Z",
      expiresAt: "2036-04-07T11:00:00.000Z",
    };
    expect(pairingLinkCanShare(owner)).toBe(false);
    expect(pairingLinkPrimaryLabel(owner)).toBe("Owner link");
    expect(pairingLinkCanShare({ ...owner, role: "client" })).toBe(true);
    expect(pairingLinkPrimaryLabel({ ...owner, role: "client", label: "iPad" })).toBe("iPad");
  });

  it("keeps this client first even when another connected more recently", () => {
    const sorted = sortClientSessions([
      session({ sessionId: AuthSessionId.make("other"), connected: true }),
      session({ sessionId: AuthSessionId.make("me"), current: true }),
    ]);
    expect(sorted.map((entry) => entry.sessionId)).toEqual(["me", "other"]);
  });
});
