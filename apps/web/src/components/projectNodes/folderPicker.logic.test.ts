import { ProjectId } from "@ryco/contracts";
import type { ProjectDestinationPreview } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFolderCrumbs,
  buildFolderPlaces,
  describeFolderSelection,
  folderSelectionStatusKey,
  highlightMatch,
  resolveFolderDestination,
  type DescribeFolderSelectionInput,
} from "./folderPicker.logic";

describe("buildFolderCrumbs", () => {
  it("starts at home for a folder under it", () => {
    expect(
      buildFolderCrumbs("/Users/me/Dropbox/Code/Web", { homeDirectory: "/Users/me" }).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["~", "Dropbox", "Code", "Web"]);
    expect(buildFolderCrumbs("~/Code").map((crumb) => [crumb.path, crumb.label])).toEqual([
      ["~", "~"],
      ["~/Code", "Code"],
    ]);
  });

  it("starts at the filesystem root outside home", () => {
    const crumbs = buildFolderCrumbs("/srv/apps", { homeDirectory: "/home/me" });
    expect(crumbs.map((crumb) => [crumb.path, crumb.label, crumb.isRoot])).toEqual([
      ["/", "/", true],
      ["/srv", "srv", false],
      ["/srv/apps", "apps", false],
    ]);
  });

  it("starts at a restricted workspace's access root", () => {
    expect(
      buildFolderCrumbs("/work/root/team/app", {
        homeDirectory: "/home/me",
        accessRoot: "/work/root",
      }).map((crumb) => crumb.label),
    ).toEqual(["/work/root", "team", "app"]);
  });

  it("handles Windows drive paths", () => {
    expect(
      buildFolderCrumbs("C:\\Code\\homelab").map((crumb) => [
        crumb.path,
        crumb.label,
        crumb.isRoot,
      ]),
    ).toEqual([
      ["C:\\", "C:", true],
      ["C:\\Code", "Code", false],
      ["C:\\Code\\homelab", "homelab", false],
    ]);
  });
});

describe("buildFolderPlaces", () => {
  it("lists home and the code roots without repeating home", () => {
    expect(
      buildFolderPlaces(
        {
          homeDirectory: "/Users/me",
          workspaceAccessRoot: null,
          codeRoots: [
            { path: "/Users/me/Code", source: "well-known", projectCount: 3 },
            { path: "/Users/me", source: "home", projectCount: 0 },
            { path: "/Users/me/Dropbox/Code/Web", source: "existing-projects", projectCount: 2 },
          ],
        },
        null,
      ).map((place) => [place.label, place.kind]),
    ).toEqual([
      ["Home", "home"],
      ["Code", "code-root"],
      ["Web", "code-root"],
    ]);
  });

  it("puts the access root first instead of home when browsing is restricted", () => {
    expect(
      buildFolderPlaces(
        {
          homeDirectory: "/home/me",
          workspaceAccessRoot: "/work/root",
          codeRoots: [{ path: "/work/root", source: "access-root", projectCount: 1 }],
        },
        null,
      ).map((place) => [place.path, place.kind]),
    ).toEqual([["/work/root", "access-root"]]);
  });

  it("falls back to home and the starting folder without hints", () => {
    expect(buildFolderPlaces(null, "~/projects/").map((place) => place.path)).toEqual([
      "~",
      "~/projects",
    ]);
  });
});

describe("highlightMatch", () => {
  it("marks the first case-insensitive occurrence", () => {
    expect(highlightMatch("~/dev/homebrew-tap", "TAP")).toEqual([
      { text: "~/dev/homebrew-", match: false },
      { text: "tap", match: true },
    ]);
    expect(highlightMatch("ryco", "zzz")).toEqual([{ text: "ryco", match: false }]);
  });
});

describe("resolveFolderDestination", () => {
  it("joins the child in parent mode and uses the selection otherwise", () => {
    expect(resolveFolderDestination("parent", "/Users/me/Code", "ryco-hub")).toBe(
      "/Users/me/Code/ryco-hub",
    );
    expect(resolveFolderDestination("parent", "/Users/me/Code", "  ")).toBeNull();
    expect(resolveFolderDestination("folder", "/Users/me/Code", "ignored")).toBe("/Users/me/Code");
    expect(resolveFolderDestination("link", null, null)).toBeNull();
  });
});

function preview(overrides: Partial<ProjectDestinationPreview>): ProjectDestinationPreview {
  return {
    resolvedPath: "/Users/me/Code/ryco",
    state: "available",
    existingProjectId: null,
    existingRepositoryCanonicalKey: null,
    suggestedPath: null,
    detail: null,
    ...overrides,
  };
}

function statusFor(overrides: Partial<DescribeFolderSelectionInput>) {
  return describeFolderSelection({
    mode: "folder",
    nodeLabel: "Mac mini",
    homeDirectory: "/Users/me",
    selectedPath: "/Users/me/Code/ryco",
    destinationPath: "/Users/me/Code/ryco",
    supportsPreview: true,
    preview: null,
    previewError: null,
    existingProject: null,
    isGitRepository: null,
    gitBranch: null,
    ...overrides,
  });
}

describe("describeFolderSelection", () => {
  it("asks for a selection first", () => {
    const status = statusFor({ selectedPath: null, destinationPath: null });
    expect([status.kind, status.usable, status.text]).toEqual([
      "empty-selection",
      false,
      "Select a folder.",
    ]);
    expect(statusFor({ mode: "parent", selectedPath: null, destinationPath: null }).text).toBe(
      "Select the folder to put it in.",
    );
  });

  it("waits for the node's preview", () => {
    const status = statusFor({});
    expect([status.kind, status.usable, status.text]).toEqual([
      "checking",
      false,
      "Checking ~/Code/ryco…",
    ]);
  });

  it("describes a repository, a plain folder and a missing folder in folder mode", () => {
    expect(
      statusFor({ preview: preview({ state: "is-git-repository" }), gitBranch: "main" }).text,
    ).toBe("Git repository on main");
    expect(statusFor({ preview: preview({ state: "exists-not-empty" }) }).kind).toBe(
      "plain-folder",
    );
    const missing = statusFor({ preview: preview({ state: "available" }) });
    expect([missing.kind, missing.tone, missing.usable]).toEqual([
      "missing-folder",
      "caution",
      true,
    ]);
  });

  it("refuses a folder that already is a project", () => {
    const named = statusFor({ existingProject: { name: "ryco" } });
    expect([named.kind, named.usable, named.text]).toEqual([
      "existing-project",
      false,
      "This is already the project ryco on Mac mini.",
    ]);
    expect(
      statusFor({ preview: preview({ existingProjectId: ProjectId.make("project-1") }) }).text,
    ).toBe("This is already a project on Mac mini.");
  });

  it("passes on the node's refusal", () => {
    const status = statusFor({
      preview: preview({ state: "access-denied", detail: "Outside the workspace root." }),
    });
    expect([status.kind, status.tone, status.usable, status.text]).toEqual([
      "refused",
      "negative",
      false,
      "Outside the workspace root.",
    ]);
  });

  it("offers the node's free path when a parent-mode destination is taken", () => {
    const status = statusFor({
      mode: "parent",
      selectedPath: "/Users/me/Code",
      destinationPath: "/Users/me/Code/ryco",
      preview: preview({ state: "exists-not-empty", suggestedPath: "/Users/me/Code/ryco-2" }),
    });
    expect([status.kind, status.usable, status.suggestedPath, status.text]).toEqual([
      "occupied",
      false,
      "/Users/me/Code/ryco-2",
      "~/Code/ryco already exists.",
    ]);
    const created = statusFor({
      mode: "parent",
      selectedPath: "/Users/me/Code",
      preview: preview({ state: "available" }),
    });
    expect([created.kind, created.usable, created.text]).toEqual([
      "new-folder",
      true,
      "Creates ~/Code/ryco",
    ]);
  });

  it("matches a checkout against the expected repository in link mode", () => {
    const same = statusFor({
      mode: "link",
      preview: preview({
        state: "is-git-repository",
        existingRepositoryCanonicalKey: "github.com/sak0a/ryco",
      }),
      gitBranch: "main",
      expectedRepositoryCanonicalKey: "github.com/sak0a/ryco",
    });
    expect([same.kind, same.usable, same.text]).toEqual([
      "same-repository",
      true,
      "Same repository, on main",
    ]);
    const other = statusFor({
      mode: "link",
      preview: preview({
        state: "is-git-repository",
        existingRepositoryCanonicalKey: "github.com/sak0a/other",
      }),
      expectedRepositoryCanonicalKey: "github.com/sak0a/ryco",
    });
    expect([other.kind, other.usable]).toEqual(["other-repository", false]);
    expect(
      statusFor({
        mode: "link",
        preview: preview({ state: "exists-not-empty" }),
        expectedRepositoryCanonicalKey: "github.com/sak0a/ryco",
      }).kind,
    ).toBe("not-a-repository");
    expect(statusFor({ mode: "link", supportsPreview: false }).kind).toBe("needs-update");
  });

  it("reports what the client knows on nodes without a preview", () => {
    const status = statusFor({ supportsPreview: false, isGitRepository: true, gitBranch: "dev" });
    expect([status.kind, status.usable, status.text]).toEqual([
      "git-repository",
      true,
      "Git repository on dev",
    ]);
    expect(statusFor({ supportsPreview: false }).kind).toBe("unchecked");
    // A typed folder its parent's listing lacks is created when the project is added.
    const missing = statusFor({ supportsPreview: false, knownMissing: true });
    expect([missing.kind, missing.usable, missing.text]).toEqual([
      "missing-folder",
      true,
      "~/Code/ryco doesn't exist yet; adding the project creates it.",
    ]);
  });

  it("keeps a failed check usable outside link mode", () => {
    const status = statusFor({ previewError: new Error("Mac mini is not connected.") });
    expect([status.kind, status.usable]).toEqual(["check-failed", true]);
    expect(statusFor({ mode: "link", previewError: new Error("offline") }).usable).toBe(false);
  });

  it("keys a status by what it says", () => {
    const first = statusFor({ preview: preview({ state: "exists-not-empty" }) });
    const second = statusFor({ preview: preview({ state: "exists-not-empty" }) });
    expect(folderSelectionStatusKey(first)).toBe(folderSelectionStatusKey(second));
    expect(folderSelectionStatusKey(first)).not.toBe(folderSelectionStatusKey(statusFor({})));
  });
});
