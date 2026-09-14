// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  MVP_ROOT_ROUTES,
  MVP_SETTINGS_SHEET_ROUTES,
  WORKSPACE_OVERLAY_ROUTE_NAMES,
  type MvpRootRouteName,
} from "./mvpRouteConfig";

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
        "ProjectSourceControl",
        "SettingsSheet",
        "Thread",
        "ThreadFile",
        "ThreadFiles",
        "ThreadReview",
        "ThreadReviewComment",
      ].toSorted(),
    );
    // Deferred routes must be absent from the tree.
    for (const absent of [
      "ThreadTerminal",
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
    expect(MVP_ROOT_ROUTES.NewTask.linking).toBe("tasks/new");
    expect(MVP_ROOT_ROUTES.Thread.linking).toBe("threads/:environmentId/:threadId");
    expect(MVP_ROOT_ROUTES.ThreadReview.linking).toBe("threads/:environmentId/:threadId/review");
    expect(MVP_ROOT_ROUTES.ThreadReviewComment.linking).toBe(
      "threads/:environmentId/:threadId/review-comment",
    );
    expect(MVP_ROOT_ROUTES.ThreadFiles.linking).toBe("threads/:environmentId/:threadId/files");
    // `:path*` and not `:path`: a workspace-relative path carries slashes, so the
    // file route only resolves as a segment wildcard.
    expect(MVP_ROOT_ROUTES.ThreadFile.linking).toBe(
      "threads/:environmentId/:threadId/files/:path*",
    );
    expect(MVP_ROOT_ROUTES.Connections.linking).toBe("connections");
    expect(MVP_ROOT_ROUTES.ConnectionsNew.linking).toBe("connections/new");
    expect(MVP_ROOT_ROUTES.SettingsSheet.linking).toBe("settings");
    expect(MVP_ROOT_ROUTES.Access.linking).toBe("account/access");
    // NotFound is the sanctioned deep-link catch-all.
    expect(MVP_ROOT_ROUTES.NotFound.linking).toBe("*");
  });

  it("keeps the Thread route flat in the root tree (not nested)", () => {
    // A flat Thread route is required for the iOS-26 shared-header morph; the
    // nested settings routes are the only nested tree.
    expect("Thread" in MVP_ROOT_ROUTES).toBe(true);
    expect("Thread" in MVP_SETTINGS_SHEET_ROUTES).toBe(false);
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
    const overlays = new Set<MvpRootRouteName>(WORKSPACE_OVERLAY_ROUTE_NAMES);
    // Sheets over the workspace.
    for (const overlay of [
      "Connections",
      "ConnectionsNew",
      "AddProject",
      "ThreadReviewComment",
      "NewTask",
      "SettingsSheet",
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
      "NotFound",
    ] as const) {
      expect(overlays.has(workspace)).toBe(false);
    }
  });

  it("presents Settings as a compact expandable iOS sheet", () => {
    expect(MVP_ROOT_ROUTES.SettingsSheet.overlay).toBe(true);
    expect(MVP_ROOT_ROUTES.SettingsSheet.ios).toEqual({
      presentation: "formSheet",
      sheetAllowedDetents: [0.78, 0.94],
      sheetGrabberVisible: true,
    });
    // Android keeps the card: a nested stack inside an Android form sheet is
    // unverified and there is no Android QA yet.
    expect(MVP_ROOT_ROUTES.SettingsSheet.android.presentation).toBe("card");
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

  it("nests the MVP settings sub-routes with their linking paths", () => {
    expect(Object.keys(MVP_SETTINGS_SHEET_ROUTES).toSorted()).toEqual(
      [
        "Settings",
        "SettingsAccount",
        "SettingsAbout",
        "SettingsAppearance",
        "SettingsClientStorage",
        "SettingsHub",
        "SettingsInbox",
        "SettingsStatistics",
        "SettingsNodeSecurity",
        "SettingsNodeVerification",
        "SettingsWorkspace",
      ].toSorted(),
    );
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsHub.linking).toBe("hub");
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsWorkspace.linking).toBe("workspace");
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsInbox.linking).toBe("inbox");
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsAppearance.linking).toBe("appearance");
    // The hosted Hub account is the ONLY route the hosted plane adds, and it is
    // nested: the root route set above is unchanged by hosted mode.
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsAccount.linking).toBe("account");
    expect("HostedSignIn" in MVP_ROOT_ROUTES).toBe(false);
    expect("SettingsAccount" in MVP_ROOT_ROUTES).toBe(false);
  });

  it("nests the relay-E2EE trust routes and gives each an explicit presentation", () => {
    // docs/relay-e2ee-protocol.md §13.1.1 / §13.2: the security surface and the
    // ceremony. Both are NESTED, so the root route set is unchanged by E2EE, and
    // both are pushes on both platforms — §13.1.1 forbids an indication that
    // "dismisses into a verified-looking state", and a swipe-away sheet is the
    // closest thing this navigator has to one.
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsNodeSecurity.linking).toBe(
      "node-security/:environmentId/:nodeId",
    );
    expect(MVP_SETTINGS_SHEET_ROUTES.SettingsNodeVerification.linking).toBe(
      "node-verification/:environmentId/:nodeId",
    );
    expect("SettingsNodeSecurity" in MVP_ROOT_ROUTES).toBe(false);
    expect("SettingsNodeVerification" in MVP_ROOT_ROUTES).toBe(false);
    for (const name of ["SettingsNodeSecurity", "SettingsNodeVerification"] as const) {
      expect(MVP_SETTINGS_SHEET_ROUTES[name].ios.presentation).toBe("card");
      expect(MVP_SETTINGS_SHEET_ROUTES[name].android.presentation).toBe("card");
    }
  });

  it("gives every nested settings route both platform decisions", () => {
    for (const [name, descriptor] of Object.entries(MVP_SETTINGS_SHEET_ROUTES)) {
      expect(descriptor.ios.presentation, `ios presentation for ${name}`).toBeDefined();
      expect(descriptor.android.presentation, `android presentation for ${name}`).toBeDefined();
    }
  });

  it("gives every visible native header an explicit navigation action", () => {
    for (const [name, descriptor] of Object.entries(MVP_ROOT_ROUTES)) {
      if (descriptor.headerPreset === "none" || name === "Home") {
        expect(descriptor.headerAction, name).toBe("none");
      } else {
        expect(["back", "close"], name).toContain(descriptor.headerAction);
      }
    }

    expect(MVP_ROOT_ROUTES.AddProject.headerAction).toBe("close");
    expect(MVP_ROOT_ROUTES.ConnectionsNew.headerAction).toBe("back");
    expect(MVP_SETTINGS_SHEET_ROUTES.Settings.headerAction).toBe("none");
    for (const [name, descriptor] of Object.entries(MVP_SETTINGS_SHEET_ROUTES)) {
      if (name !== "Settings") expect(descriptor.headerAction, name).toBe("back");
    }
  });

  it("keeps every nested settings linking path distinct", () => {
    const paths = Object.values(MVP_SETTINGS_SHEET_ROUTES).map((route) => route.linking);
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
describe("the settings navigator matches the settings route table", () => {
  const SRC = join(import.meta.dirname, "..");
  const stack = readFileSync(join(SRC, "Stack.tsx"), "utf8");

  function registeredSettingsScreens(): readonly string[] {
    const block = stack.slice(
      stack.indexOf("const SettingsSheetStack = createNativeStackNavigator({"),
      stack.indexOf("export const WORKSPACE_OVERLAY_ROUTES"),
    );
    return [...block.matchAll(/^ {4}(\w+): createNativeStackScreen\(\{$/gmu)].map(
      (match) => match[1]!,
    );
  }

  it("registers exactly the routes the table declares", () => {
    expect(registeredSettingsScreens().toSorted()).toEqual(
      Object.keys(MVP_SETTINGS_SHEET_ROUTES).toSorted(),
    );
  });

  it("applies each descriptor's platform presentation rather than a hand-written option", () => {
    // Otherwise the `ios`/`android` fields are a constant the tests above assert
    // about and the navigator ignores, and §13.1.1's "no sheet that dismisses
    // into a verified-looking state" holds only by accident.
    for (const name of Object.keys(MVP_SETTINGS_SHEET_ROUTES)) {
      expect(stack, name).toContain(`settingsRouteOptions("${name}",`);
      expect(stack, name).toContain(`MVP_SETTINGS_SHEET_ROUTES.${name}.linking`);
    }
  });

  it("reaches the §13.1.1 security surface from the settings screen", () => {
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
      SettingsSheet: [
        "features/settings/SettingsRouteScreen.tsx",
        'accessibilityLabel="Close Settings"',
      ],
    } as const;

    for (const [name, [path, marker]] of Object.entries(dismissalControls)) {
      expect(MVP_ROOT_ROUTES[name as keyof typeof MVP_ROOT_ROUTES].headerPreset, name).toBe("none");
      expect(readFileSync(join(SRC, path), "utf8"), name).toContain(marker);
    }
  });
});
