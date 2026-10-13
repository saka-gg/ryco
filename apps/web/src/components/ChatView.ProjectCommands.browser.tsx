import { WS_METHODS, type MessageId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerMenuItem,
  waitForServerConfigToApply,
  wsRequests,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const projectCommandReads = () =>
  wsRequests.filter((request) => request._tag === WS_METHODS.providerReadProjectCommands);

describe("ChatView project skills and slash commands (full app)", () => {
  setupChatViewBrowserSuite();

  it("reads the directory's commands on the first slash and lists them with the snapshot's", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-commands" as MessageId,
        targetText: "project commands target",
      }),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            capabilities: {
              ...fixture.serverConfig.environment.capabilities,
              providerProjectCommands: true,
            },
          },
        };
      },
      resolveRpc: (body) =>
        body._tag === WS_METHODS.providerReadProjectCommands
          ? {
              skills: [],
              slashCommands: [{ name: "release-notes", description: "Project command" }],
            }
          : undefined,
    });
    try {
      await waitForServerConfigToApply();
      const editor = await waitForComposerEditor();
      editor.focus();
      expect(projectCommandReads()).toHaveLength(0);
      await vi.waitFor(async () => {
        await page.getByTestId("composer-editor").fill("/");
        expect(projectCommandReads().length).toBeGreaterThan(0);
      });
      expect(projectCommandReads()[0]).toMatchObject({ cwd: expect.any(String) });
      const item = await waitForComposerMenuItem(`provider-slash-command:codex:release-notes`);
      expect(item.textContent).toContain("/release-notes");
      // Built-in commands are still offered.
      await waitForComposerMenuItem("slash:model");
      // Typing on reuses the directory's read.
      await page.getByTestId("composer-editor").fill("/rel");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(projectCommandReads()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
