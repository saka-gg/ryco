import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_NODE_SERVICE_LABEL,
  isEphemeralCliInstall,
  nodeServiceDefinitionPath,
  nodeServiceLabel,
  nodeServiceLingerCommand,
  nodeServiceUser,
  parseLaunchctlPrint,
  parseSystemctlShow,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
  systemdUnitName,
  type NodeServiceSpec,
} from "./nodeService.ts";
import { sleepInhibitorCommand } from "./sleepInhibitor.ts";

const spec: NodeServiceSpec = {
  label: DEFAULT_NODE_SERVICE_LABEL,
  execPath: "/opt/homebrew/bin/node",
  scriptPath: "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
  args: [
    "serve",
    "--base-dir",
    "/Users/me/.ryco",
    "--hub-node-name",
    "Mac & <mini>",
    "/Users/me/code",
  ],
  workingDirectory: "/Users/me/code",
  logPath: "/Users/me/.ryco/userdata/logs/service.log",
  environment: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" },
};

describe("node service definitions", () => {
  it("labels the default state directory plainly and any other stably", () => {
    expect(nodeServiceLabel("/Users/me/.ryco", "/Users/me/.ryco")).toBe("space.ryco.node");
    const other = nodeServiceLabel("/Users/me/second-node", "/Users/me/.ryco");
    expect(other).toMatch(/^space\.ryco\.node\.[0-9a-f]{8}$/u);
    expect(nodeServiceLabel("/Users/me/second-node/", "/Users/me/.ryco")).toBe(other);
    expect(systemdUnitName("space.ryco.node")).toBe("ryco-node.service");
    expect(systemdUnitName(other)).toMatch(/^ryco-node-[0-9a-f]{8}\.service$/u);
  });

  it("places definitions where launchd and systemd look for user services", () => {
    expect(nodeServiceDefinitionPath("launchd", "space.ryco.node", "/Users/me")).toBe(
      "/Users/me/Library/LaunchAgents/space.ryco.node.plist",
    );
    expect(nodeServiceDefinitionPath("systemd", "space.ryco.node", "/home/me")).toBe(
      "/home/me/.config/systemd/user/ryco-node.service",
    );
  });

  it("renders a LaunchAgent that runs at load, stays alive, and escapes values", () => {
    const plist = renderLaunchAgentPlist(spec);
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>Mac &amp; &lt;mini&gt;</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).not.toContain("Mac & <mini>");
  });

  it("renders a systemd unit that restarts and quotes every argument", () => {
    const unit = renderSystemdUserUnit({ ...spec, args: [...spec.args, "100%"] });
    expect(unit).toContain(
      'ExecStart="/opt/homebrew/bin/node" "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs" "serve"',
    );
    expect(unit).toContain('"Mac & <mini>"');
    expect(unit).toContain('"100%%"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain('Environment="HOME=/Users/me"');
    expect(unit).toContain("StandardOutput=append:/Users/me/.ryco/userdata/logs/service.log");
  });

  it("refuses installs that disappear after a reboot", () => {
    expect(
      isEphemeralCliInstall("/Users/me/.npm/_npx/abc/node_modules/ryco-cli/dist/bin.mjs"),
    ).toBe(true);
    expect(isEphemeralCliInstall("/Users/me/.bun/install/cache/ryco-cli@0.1.27/dist/bin.mjs")).toBe(
      true,
    );
    expect(isEphemeralCliInstall("/tmp/x/bin.mjs", "/tmp")).toBe(true);
    expect(
      isEphemeralCliInstall("/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs", "/tmp"),
    ).toBe(false);
  });

  it("reads launchctl and systemctl state", () => {
    expect(parseLaunchctlPrint("space.ryco.node = {\n\tstate = running\n\tpid = 4242\n}")).toEqual({
      running: true,
      pid: 4242,
    });
    expect(parseLaunchctlPrint("\tstate = not running\n")).toEqual({ running: false, pid: null });
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\nMainPID=77\n")).toEqual({
      loaded: true,
      running: true,
      pid: 77,
    });
    expect(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\nMainPID=0\n")).toEqual({
      loaded: false,
      running: false,
      pid: null,
    });
  });

  it("ties the sleep assertion to the server's own process", () => {
    expect(sleepInhibitorCommand("darwin", 99)).toMatchObject({
      command: "caffeinate",
      args: ["-s", "-w", "99"],
    });
    expect(sleepInhibitorCommand("linux", 99)?.args).toContain("--pid=99");
    expect(sleepInhibitorCommand("win32", 99)).toBeNull();
  });

  it("enables lingering for the service user through sudo unless already root", () => {
    expect(nodeServiceLingerCommand("ada", 1000)).toEqual({
      command: "sudo",
      args: ["loginctl", "enable-linger", "ada"],
    });
    expect(nodeServiceLingerCommand("root", 0)).toEqual({
      command: "loginctl",
      args: ["enable-linger", "root"],
    });
    expect(nodeServiceUser({ USER: "ada", LOGNAME: "other" })).toBe("ada");
    expect(nodeServiceUser({ LOGNAME: "ada" })).toBe("ada");
    expect(nodeServiceUser({})).toBe("");
  });
});
