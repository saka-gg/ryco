import { AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID, EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChatsAutomationSnapshot,
  CHATS_AUTOMATION_PROJECT_KEY,
  chatsAutomationRootOf,
  isChatsAutomationSnapshot,
} from "./chatsAutomationScope.logic";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");

describe("chatsAutomationScope", () => {
  it("offers 'No project' only on devices that take such schedules", () => {
    expect(chatsAutomationRootOf(null)).toBeNull();
    expect(chatsAutomationRootOf({ chats: { available: true } } as never)).toBeNull();
    expect(
      chatsAutomationRootOf({
        chats: { available: true, root: "/Users/me/Chats" },
        chatAutomations: true,
      } as never),
    ).toBe("/Users/me/Chats");
    expect(
      chatsAutomationRootOf({ chats: { available: false }, chatAutomations: true } as never),
    ).toBe("");
    expect(buildChatsAutomationSnapshot({ devices: [], primaryEnvironmentId: LOCAL })).toBeNull();
  });

  it("is one entry with a checkout per device, this device first", () => {
    const snapshot = buildChatsAutomationSnapshot({
      devices: [
        { environmentId: STUDIO, root: "/Volumes/Studio/Chats", label: "Studio" },
        { environmentId: LOCAL, root: "", label: null },
      ],
      primaryEnvironmentId: LOCAL,
    });
    expect(snapshot).not.toBeNull();
    expect(isChatsAutomationSnapshot(snapshot!)).toBe(true);
    expect(snapshot!.projectKey).toBe(CHATS_AUTOMATION_PROJECT_KEY);
    expect(snapshot!.displayName).toBe("No project");
    expect(snapshot!.environmentPresence).toBe("mixed");
    expect(snapshot!.remoteEnvironmentLabels).toEqual(["Studio"]);
    expect(
      snapshot!.memberProjects.map((member) => [member.environmentId, member.id, member.cwd]),
    ).toEqual([
      [LOCAL, AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID, "Chats"],
      [STUDIO, AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID, "/Volumes/Studio/Chats"],
    ]);
  });
});
