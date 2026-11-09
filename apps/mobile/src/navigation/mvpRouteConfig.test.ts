// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  statisticsLinkPath,
  statisticsTabParam,
} from "../features/settings/statistics/statisticsRoute";
import {
  MVP_ALL_ROOT_ROUTES,
  MVP_ROOT_ROUTES,
  MVP_SETTINGS_ROUTES,
  WORKSPACE_OVERLAY_ROUTE_NAMES,
  type MvpAnyRootRouteName,
} from "./mvpRouteConfig";
import {
  MAIN_TAB_NAMES,
  MAIN_TABS,
  rewriteLegacyTabPath,
  tabBarItemTitle,
} from "./tabs/mainTabsModel";

interface ParsedRoute {
  readonly name: string;
  readonly params?: Record<string, unknown>;
  readonly state?: { readonly routes: readonly ParsedRoute[] };
}

/** React Navigation's own link parser, over the app's linking tree (tabs nested in Home). */
function parseLink(path: string): ParsedRoute | undefined {
  const mobileRequire = createRequire(new URL("../../package.json", import.meta.url));
  const nativeRequire = createRequire(mobileRequire.resolve("@react-navigation/native"));
  const { getStateFromPath } = nativeRequire("@react-navigation/core") as {
    getStateFromPath(
      path: string,
      config: unknown,
    ): { readonly routes: readonly ParsedRoute[] } | undefined;
  };
  const tabs = Object.fromEntries(MAIN_TAB_NAMES.map((name) => [name, MAIN_TABS[name].linking]));
  const screens: Record<string, unknown> = Object.fromEntries(
    Object.entries(MVP_ALL_ROOT_ROUTES).map(([name, route]) => [name, route.linking]),
  );
  screens.Home = { path: MVP_ROOT_ROUTES.Home.linking, screens: tabs };
  const state = getStateFromPath(rewriteLegacyTabPath(path), { screens });
  return state?.routes.at(-1);
}

describe("MVP route config", () => {
  it("registers exactly the MVP root route set plus the NotFound catch-all", () => {
    expect(Object.keys(MVP_ROOT_ROUTES).toSorted()).toEqual(
      [
        "Access",
        "AddProject",
        "Connections",
        "ConnectionsNew",
        "Home",
        "NewTask",
        "NotFound",
        "Project",
        "ProjectPullRequest",
        "ProjectPullRequestFile",
        "ProjectPullRequests",
        "ProjectSourceControl",
        "Search",
        "TaskDetail",
        "Thread",
        "ThreadFile",
        "ThreadFiles",
        "ThreadReview",
        "ThreadReviewComment",
        "ThreadTerminal",
        "ThreadDevice",
      ].toSorted(),
    );
    // Deferred routes must be absent from the tree.
    for (const absent of [
      "GitOverview",
      "NewTaskSheet",
      "SettingsLegal",
      "ConnectOnboarding",
      "SettingsArchive",
    ]) {
      expect(absent in MVP_ROOT_ROUTES).toBe(false);
    }
  });

  it("uses the exact MVP linking path strings", () => {
    expect(MVP_ROOT_ROUTES.Home.linking).toBe("");
    expect(MVP_ROOT_ROUTES.AddProject.linking).toBe("projects/new");
    expect(MVP_ROOT_ROUTES.Project.linking).toBe("projects/:environmentId/:projectId");
    expect(MVP_ROOT_ROUTES.ProjectSourceControl.linking).toBe(
      "projects/:environmentId/:projectId/source-control/:worktreeId?",
    );
    expect(MVP_ROOT_ROUTES.ProjectPullRequests.linking).toBe(
      "projects/:environmentId/:projectId/pull-requests",
    );
    expect(MVP_ROOT_ROUTES.ProjectPullRequest.linking).toBe(
      "projects/:environmentId/:projectId/pull-requests/:number",
    );
    expect(MVP_ROOT_ROUTES.ProjectPullRequestFile.linking).toBe(
      "projects/:environmentId/:projectId/pull-requests/:number/files/:path*",
    );
    expect(MVP_ROOT_ROUTES.NewTask.linking).toBe("tasks/new");
    expect(MVP_ROOT_ROUTES.Thread.linking).toBe("threads/:environmentId/:threadId");
    expect(MVP_ROOT_ROUTES.ThreadReview.linking).toBe("threads/:environmentId/:threadId/review");
    expect(MVP_ROOT_ROUTES.ThreadReviewComment.linking).toBe(
      "threads/:environmentId/:threadId/review-comment",
    );
    expect(MVP_ROOT_ROUTES.ThreadFiles.linking).toBe("threads/:environmentId/:threadId/files");
    expect(MVP_ROOT_ROUTES.ThreadTerminal.linking).toBe(
      "threads/:environmentId/:threadId/terminal",
    );
    // `:path*` and not `:path`: a workspace-relative path carries slashes, so the
    // file route only resolves as a segment wildcard.
    expect(MVP_ROOT_ROUTES.ThreadFile.linking).toBe(
      "threads/:environmentId/:threadId/files/:path*",
    );
    expect(MVP_ROOT_ROUTES.Connections.linking).toBe("connections");
    expect(MVP_ROOT_ROUTES.ConnectionsNew.linking).toBe("connections/new");
    expect(MVP_ROOT_ROUTES.Search.linking).toBe("search");
    expect(MVP_ROOT_ROUTES.Access.linking).toBe("account/access");
    // NotFound is the sanctioned deep-link catch-all.
    expect(MVP_ROOT_ROUTES.NotFound.linking).toBe("*");
  });

  it("keeps the Thread route flat in the root tree (not nested)", () => {
    // A flat Thread route is required for the iOS-26 shared-header morph; the
    // nested settings routes are the only nested tree.
    expect("Thread" in MVP_ROOT_ROUTES).toBe(true);
    expect("Thread" in MVP_SETTINGS_ROUTES).toBe(false);
  });

  it("presents New Task as an expandable iOS sheet with an explicit close action", () => {
    expect(MVP_ROOT_ROUTES.NewTask.ios).toEqual({
      presentation: "formSheet",
      sheetAllowedDetents: [0.62, 0.94],
      sheetGrabberVisible: true,
    });
    expect(MVP_ROOT_ROUTES.NewTask.headerAction).toBe("close");
    expect(WORKSPACE_OVERLAY_ROUTE_NAMES).toContain("NewTask");
  });

  it("presents a task as an expandable iOS sheet with an explicit close action", () => {
    expect(MVP_ROOT_ROUTES.TaskDetail.linking).toBe("todo/:environmentId/:taskId");
    expect(MVP_ROOT_ROUTES.TaskDetail.ios).toEqual({
      presentation: "formSheet",
      sheetAllowedDetents: [0.7, 0.94],
      sheetGrabberVisible: true,
    });
    expect(MVP_ROOT_ROUTES.TaskDetail.headerAction).toBe("close");
    expect(WORKSPACE_OVERLAY_ROUTE_NAMES).toContain("TaskDetail");
  });

  it("presents the review-comment sheet with detents on iOS and fullScreenModal on Android", () => {
    const route = MVP_ROOT_ROUTES.ThreadReviewComment;
    expect(route.ios.presentation).toBe("formSheet");
    expect(route.ios.sheetAllowedDetents).toEqual([0.55, 0.92]);
    expect(route.ios.sheetGrabberVisible).toBe(true);
    expect(route.android.presentation).toBe("fullScreenModal");
    // Grabber is non-Android only.
    expect(route.android.sheetGrabberVisible).toBe(false);
  });

  it("marks every sheet/overlay route so it is excluded from the workspace pathname", () => {
    const overlays = new Set<MvpAnyRootRouteName>(WORKSPACE_OVERLAY_ROUTE_NAMES);
    // Sheets over the workspace.
    for (const overlay of [
      "Connections",
      "ConnectionsNew",
      "AddProject",
      "ThreadReviewComment",
      "NewTask",
      "ThreadDevice",
    ] as const) {
      expect(overlays.has(overlay)).toBe(true);
    }
    // The workspace routes themselves are never overlays.
    for (const workspace of [
      "Access",
      "Home",
      "Project",
      "ProjectSourceControl",
      "Thread",
      "ThreadReview",
      "ThreadFiles",
      "ThreadFile",
      "ThreadTerminal",
      "Search",
      "SettingsHub",
      "SettingsNodeSecurity",
      "NotFound",
    ] as const) {
      expect(overlays.has(workspace)).toBe(false);
    }
  });

  it("lists the main tabs in the decided order, with links and icons", () => {
    expect(MAIN_TAB_NAMES).toEqual(["Chats", "Tasks", "PullRequests", "Usage", "Settings"]);
    expect(MAIN_TAB_NAMES.map((name) => MAIN_TABS[name].linking)).toEqual([
      "",
      "tasks",
      "pull-requests",
      "usage",
      "settings",
    ]);
    for (const name of MAIN_TAB_NAMES) {
      expect(MAIN_TABS[name].icon.type, name).toMatch(/^(sfSymbol|template)$/);
      expect(MAIN_TABS[name].label, name).not.toBe("");
    }
  });

  it("uses t3code's tab icons, filled while selected where a filled glyph exists", () => {
    expect(MAIN_TAB_NAMES.map((name) => MAIN_TABS[name].icon)).toEqual([
      { type: "sfSymbol", name: "text.bubble" },
      { type: "sfSymbol", name: "checklist" },
      { type: "template", asset: "pullRequest" },
      { type: "sfSymbol", name: "chart.bar.xaxis" },
      { type: "sfSymbol", name: "gearshape" },
    ]);
    expect(MAIN_TABS.Chats.selectedIcon).toEqual({ type: "sfSymbol", name: "text.bubble.fill" });
    expect(MAIN_TABS.Settings.selectedIcon).toEqual({ type: "sfSymbol", name: "gearshape.fill" });
  });

  it("shows icons only, but names an Android tab it has no icon for", () => {
    expect(tabBarItemTitle({ platform: "ios", hasPlatformIcon: true, label: "Chats" })).toBe("");
    expect(tabBarItemTitle({ platform: "android", hasPlatformIcon: true, label: "PRs" })).toBe("");
    expect(tabBarItemTitle({ platform: "android", hasPlatformIcon: false, label: "Chats" })).toBe(
      "Chats",
    );
  });

  it("opens each tab from its link, and the root at Chats", () => {
    for (const name of MAIN_TAB_NAMES) {
      const route = parseLink(MAIN_TABS[name].linking);
      expect(route?.name, name).toBe("Home");
      expect(route?.state?.routes[0]?.name, name).toBe(name);
    }
    // "tasks/new" stays New Task, beside the Tasks tab's "tasks".
    expect(parseLink("tasks/new")?.name).toBe("NewTask");
  });

  it("opens Settings pages as pushes above the tabs, at their old links", () => {
    expect(parseLink("settings/hub")?.name).toBe("SettingsHub");
    expect(parseLink("settings/node-security/env/node")).toMatchObject({
      name: "SettingsNodeSecurity",
      params: { environmentId: "env", nodeId: "node" },
    });
  });

  it("presents Add Project as a workspace overlay and Project as a push", () => {
    expect(MVP_ROOT_ROUTES.AddProject.ios.presentation).toBe("formSheet");
    expect(MVP_ROOT_ROUTES.AddProject.ios.sheetAllowedDetents).toEqual([0.7, 0.95]);
    expect(MVP_ROOT_ROUTES.Project.ios.presentation).toBe("card");
  });

  it("keeps ConnectionsNew a card (deliberate divergence from upstream's formSheet)", () => {
    expect(MVP_ROOT_ROUTES.ConnectionsNew.ios.presentation).toBe("card");
    expect(MVP_ROOT_ROUTES.ConnectionsNew.android.presentation).toBe("card");
  });

  it("lists the Settings tab's pages with their linking paths", () => {
    expect(Object.keys(MVP_SETTINGS_ROUTES).toSorted()).toEqual(
      [
        "SettingsAccount",
        "SettingsAbout",
        "SettingsArchived",
        "SettingsAppearance",
        "SettingsClientStorage",
        "SettingsDiagnostics",
        "SettingsHub",
        "SettingsInbox",
        "SettingsNotifications",
        "SettingsProviderAccounts",
        "SettingsNodeSecurity",
        "SettingsNodeVerification",
        "SettingsWorkspace",
      ].toSorted(),
    );
    expect(MVP_SETTINGS_ROUTES.SettingsHub.linking).toBe("settings/hub");
    expect(MVP_SETTINGS_ROUTES.SettingsWorkspace.linking).toBe("settings/workspace");
    expect(MVP_SETTINGS_ROUTES.SettingsInbox.linking).toBe("settings/inbox");
    expect(MVP_SETTINGS_ROUTES.SettingsArchived.linking).toBe("settings/archived");
    expect(MVP_SETTINGS_ROUTES.SettingsNotifications.linking).toBe("settings/notifications");
    expect(MVP_SETTINGS_ROUTES.SettingsAppearance.linking).toBe("settings/appearance");
    expect(MVP_SETTINGS_ROUTES.SettingsProviderAccounts.linking).toBe("settings/provider-accounts");
    expect(MVP_SETTINGS_ROUTES.SettingsDiagnostics.linking).toBe("settings/diagnostics");
    expect(MVP_SETTINGS_ROUTES.SettingsAccount.linking).toBe("settings/account");
    expect("HostedSignIn" in MVP_ALL_ROOT_ROUTES).toBe(false);
  });

  it("pushes the relay-E2EE trust routes on both platforms", () => {
    // docs/relay-e2ee-protocol.md §13.1.1 / §13.2: the security surface and the
    // ceremony are pushes — §13.1.1 forbids an indication that "dismisses into
    // a verified-looking state", and a swipe-away sheet is the closest thing
    // this navigator has to one.
    expect(MVP_SETTINGS_ROUTES.SettingsNodeSecurity.linking).toBe(
      "settings/node-security/:environmentId/:nodeId",
    );
    expect(MVP_SETTINGS_ROUTES.SettingsNodeVerification.linking).toBe(
      "settings/node-verification/:environmentId/:nodeId",
    );
    for (const name of ["SettingsNodeSecurity", "SettingsNodeVerification"] as const) {
      expect(MVP_SETTINGS_ROUTES[name].ios.presentation).toBe("card");
      expect(MVP_SETTINGS_ROUTES[name].android.presentation).toBe("card");
      expect(MVP_SETTINGS_ROUTES[name].overlay).toBe(false);
    }
  });

  it("opens Usage on the view a link names, such as a Limits widget's tap", () => {
    expect(statisticsLinkPath("limits")).toBe("usage?tab=limits");
    const route = parseLink(statisticsLinkPath("limits"));
    expect(route?.state?.routes[0]).toMatchObject({ name: "Usage", params: { tab: "limits" } });
    // A widget an earlier build wrote still opens the same view.
    const legacy = parseLink("settings/statistics?tab=limits");
    expect(legacy?.state?.routes[0]).toMatchObject({ name: "Usage", params: { tab: "limits" } });
    expect(rewriteLegacyTabPath("/settings/statistics")).toBe("/usage");
    expect(rewriteLegacyTabPath("settings/hub")).toBe("settings/hub");
    expect(statisticsTabParam(["activity", "usage"])).toBe("activity");
    // An unknown or missing tab leaves the screen on its default.
    expect(statisticsTabParam("billing")).toBeNull();
    expect(statisticsTabParam(undefined)).toBeNull();
  });

  it("gives every visible native header an explicit navigation action", () => {
    for (const [name, descriptor] of Object.entries(MVP_ALL_ROOT_ROUTES) as ReadonlyArray<
      [string, { readonly headerPreset: string; readonly headerAction: string }]
    >) {
      if (descriptor.headerPreset === "none" || name === "Home") {
        expect(descriptor.headerAction, name).toBe("none");
      } else {
        expect(["back", "close"], name).toContain(descriptor.headerAction);
      }
    }

    expect(MVP_ROOT_ROUTES.AddProject.headerAction).toBe("close");
    expect(MVP_ROOT_ROUTES.ConnectionsNew.headerAction).toBe("back");
    for (const [name, descriptor] of Object.entries(MVP_SETTINGS_ROUTES)) {
      expect(descriptor.headerAction, name).toBe("back");
    }
  });

  it("keeps every root linking path distinct", () => {
    const paths = Object.values(MVP_ALL_ROOT_ROUTES).map((route) => route.linking);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * The table above is data; the navigator is what ships.
 *
 * Nothing tied the two together, so deleting a screen block from `Stack.tsx`
 * left every assertion above passing while `navigate("SettingsNodeSecurity")`
 * became a silent no-op — the §13.1.1 persistent indication and the §13.2
 * ceremony unreachable in the built app. The `as never` casts on the navigate
 * calls mean the type checker does not close the gap either, so it is closed
 * here, over the source.
 */
describe("the root navigator matches the route table", () => {
  const SRC = join(import.meta.dirname, "..");
  const stack = readFileSync(join(SRC, "Stack.tsx"), "utf8");

  function registeredRootScreens(): readonly string[] {
    const block = stack.slice(
      stack.indexOf("export const ROOT_STACK_SCREENS = {"),
      stack.indexOf("export const RootStack = createNativeStackNavigator({"),
    );
    return [...block.matchAll(/^ {2}(\w+): createNativeStackScreen\(\{$/gmu)].map(
      (match) => match[1]!,
    );
  }

  it("registers exactly the routes the table declares", () => {
    expect(registeredRootScreens().toSorted()).toEqual(Object.keys(MVP_ALL_ROOT_ROUTES).toSorted());
  });

  it("applies each descriptor's platform presentation rather than a hand-written option", () => {
    // Otherwise the `ios`/`android` fields are a constant the tests above assert
    // about and the navigator ignores, and §13.1.1's "no sheet that dismisses
    // into a verified-looking state" holds only by accident.
    for (const name of Object.keys(MVP_SETTINGS_ROUTES)) {
      expect(stack, name).toContain(`routeOptions("${name}",`);
      expect(stack, name).toContain(`MVP_SETTINGS_ROUTES.${name}.linking`);
    }
  });

  it("reaches the §13.1.1 security surface from the Settings tab", () => {
    const settings = readFileSync(
      join(SRC, "features", "settings", "SettingsRouteScreen.tsx"),
      "utf8",
    );
    expect(settings).toContain('StackActions.push("SettingsNodeSecurity"');
    expect(settings).toContain("exactNodeRouteParams(selectedNode)");
    // …and the ceremony is reached from the security surface itself.
    const security = readFileSync(
      join(SRC, "features", "e2ee", "E2eeNodeSecurityRouteScreen.tsx"),
      "utf8",
    );
    expect(security).toContain('StackActions.push("SettingsNodeVerification"');
    expect(security).toContain("exactNodeRouteParams(target.node)");
  });

  it("keeps an explicit dismissal control on every headerless workspace overlay", () => {
    const dismissalControls = {
      Connections: ["features/nodes/NodesScreen.tsx", 'accessibilityLabel="Close Machines"'],
      ThreadReviewComment: [
        "features/review/ReviewCommentComposerSheet.tsx",
        'accessibilityLabel="Cancel review comment"',
      ],
      Search: ["features/search/GlobalSearchRouteScreen.tsx", ">Cancel</Text>"],
    } as const;

    for (const [name, [path, marker]] of Object.entries(dismissalControls)) {
      expect(MVP_ROOT_ROUTES[name as keyof typeof MVP_ROOT_ROUTES].headerPreset, name).toBe("none");
      expect(readFileSync(join(SRC, path), "utf8"), name).toContain(marker);
    }
  });
});
