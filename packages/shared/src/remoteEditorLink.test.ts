import { describe, expect, it } from "vite-plus/test";

import {
  REMOTE_CAPABLE_EDITOR_IDS,
  buildRemoteEditorLink,
  isRemoteEditorLink,
  sshEditorDestination,
} from "./remoteEditorLink.ts";

describe("remote editor links", () => {
  it("opens a file at its line in the VS Code family over Remote-SSH", () => {
    expect(
      buildRemoteEditorLink({
        editor: "vscode",
        host: "build-box",
        target: "/home/me/my repo/src/app.ts:12:4",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+build-box/home/me/my%20repo/src/app.ts:12:4");
    expect(
      buildRemoteEditorLink({
        editor: "cursor",
        host: "10.0.0.5",
        username: "me",
        target: "/srv/project",
      }),
    ).toBe("cursor://vscode-remote/ssh-remote+me%4010.0.0.5/srv/project");
  });

  it("roots a Windows path and keeps Zed's userinfo literal", () => {
    expect(
      buildRemoteEditorLink({ editor: "vscode-insiders", host: "win", target: "C:\\code\\x.ts" }),
    ).toBe("vscode-insiders://vscode-remote/ssh-remote+win/C%3A/code/x.ts");
    expect(
      buildRemoteEditorLink({ editor: "zed", host: "box", username: "me", target: "/a b" }),
    ).toBe("zed://ssh/me@box/a%20b");
  });

  it("has no link for editors without SSH support", () => {
    expect(buildRemoteEditorLink({ editor: "sublime-text", host: "box", target: "/a" })).toBe(
      undefined,
    );
    expect(REMOTE_CAPABLE_EDITOR_IDS).toEqual(
      expect.arrayContaining(["vscode", "cursor", "windsurf", "vscodium", "zed"]),
    );
    expect(REMOTE_CAPABLE_EDITOR_IDS).not.toContain("xcode");
  });

  it("splits a user@host alias and keeps a bare SSH config alias whole", () => {
    expect(sshEditorDestination({ alias: "me@box.local", username: null })).toEqual({
      host: "box.local",
      username: "me",
    });
    expect(sshEditorDestination({ alias: "build-box", username: "deploy" })).toEqual({
      host: "build-box",
      username: "deploy",
    });
    expect(sshEditorDestination({ alias: "  " })).toBeNull();
  });

  it("recognizes only the links it builds", () => {
    for (const editor of REMOTE_CAPABLE_EDITOR_IDS) {
      const link = buildRemoteEditorLink({ editor, host: "box", username: "me", target: "/a:3" });
      expect(link && isRemoteEditorLink(link)).toBe(true);
    }
    for (const url of [
      "https://example.com",
      "file:///etc/passwd",
      "vscode://vscode.git/clone?url=x",
      "vscode://ms-vscode.remote-server/x",
      "cursor://vscode-remote/wsl+Ubuntu/x",
      "zed://ssh",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isRemoteEditorLink(url)).toBe(false);
    }
  });
});
