import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { PROJECT_COPY_MAX_CODE_ROOTS } from "@ryco/contracts/project-copy";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { projectParentDirectories, resolveNodeCodeRoots } from "./codeRoots.ts";

let scratch: string;
let home: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-code-roots-")));
  home = path.join(scratch, "home");
  await mkdir(home);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const resolve = (input: {
  readonly workspaceAccessRoot?: string;
  readonly addProjectBaseDirectory?: string;
  readonly projectRoots?: ReadonlyArray<string>;
  readonly temporaryDirectories?: ReadonlyArray<string>;
}) =>
  resolveNodeCodeRoots({
    workspaceAccessRoot: input.workspaceAccessRoot,
    addProjectBaseDirectory: input.addProjectBaseDirectory ?? "",
    homeDir: home,
    projectRoots: input.projectRoots ?? [],
    // The scratch folder is itself in the OS temporary directory; tests name theirs explicitly.
    temporaryDirectories: input.temporaryDirectories ?? [],
  });

/** Two project folders, `a` and `b`, in `folder`; their roots. */
const projectPair = async (folder: string) => {
  const roots = [path.join(folder, "a"), path.join(folder, "b")];
  await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
  return roots;
};

describe("projectParentDirectories", () => {
  it("counts projects per parent, most first, then shorter and alphabetical", () => {
    expect(
      projectParentDirectories(
        ["/w/b/one", "/w/a/one", "/w/b/two/", "/w/a/two", "/x/one", "/w/a/three", "/"],
        "linux",
      ),
    ).toEqual([
      { path: "/w/a", projectCount: 3 },
      { path: "/w/b", projectCount: 2 },
      { path: "/x", projectCount: 1 },
    ]);
  });

  it("groups parents case-insensitively on case-insensitive volumes", () => {
    expect(projectParentDirectories(["/Code/a", "/code/b"], "darwin")).toEqual([
      { path: "/Code", projectCount: 2 },
    ]);
    expect(projectParentDirectories(["/Code/a", "/code/b"], "linux")).toHaveLength(2);
  });
});

describe("resolveNodeCodeRoots", () => {
  it("falls back from well-known folders to home", async () => {
    expect(await resolve({})).toEqual({
      defaultProjectDirectory: home,
      defaultProjectDirectorySource: "home",
      codeRoots: [{ path: home, source: "home", projectCount: 0 }],
    });
    await mkdir(path.join(home, "src"));
    await mkdir(path.join(home, "Developer"));
    const roots = await resolve({});
    expect(roots.defaultProjectDirectory).toBe(path.join(home, "Developer"));
    expect(roots.defaultProjectDirectorySource).toBe("well-known");
    expect(roots.codeRoots.map((root) => root.path)).toEqual([
      path.join(home, "Developer"),
      path.join(home, "src"),
      home,
    ]);
  });

  it("prefers the folder holding at least two projects over well-known folders", async () => {
    await mkdir(path.join(home, "Code"));
    const work = path.join(scratch, "work");
    await mkdir(path.join(work, "a"), { recursive: true });
    const lone = path.join(scratch, "lone");
    await mkdir(lone);
    const projectRoots = [path.join(work, "a"), path.join(work, "b"), path.join(lone, "c")];
    const roots = await resolve({ projectRoots });
    expect(roots.defaultProjectDirectory).toBe(work);
    expect(roots.defaultProjectDirectorySource).toBe("existing-projects");
    expect(roots.codeRoots).toEqual([
      { path: work, source: "existing-projects", projectCount: 2 },
      { path: path.join(home, "Code"), source: "well-known", projectCount: 0 },
      { path: lone, source: "existing-projects", projectCount: 1 },
      { path: home, source: "home", projectCount: 0 },
    ]);
    // One project per folder is not a pattern: the well-known folder stays the default.
    expect((await resolve({ projectRoots: projectRoots.slice(1) })).defaultProjectDirectory).toBe(
      path.join(home, "Code"),
    );
  });

  it("counts a monorepo's subfolder projects as the repository, never its inner folders", async () => {
    await mkdir(path.join(home, "Code"));
    const mono = path.join(home, "Code", "mono");
    await mkdir(path.join(mono, ".git"), { recursive: true });
    await mkdir(path.join(mono, "packages", "app"), { recursive: true });
    await mkdir(path.join(mono, "packages", "web"), { recursive: true });
    await mkdir(path.join(home, "Code", "ryco", ".git"), { recursive: true });
    const subprojects = [path.join(mono, "packages", "app"), path.join(mono, "packages", "web")];

    // Two subfolder projects of one repository are one folder in ~/Code, beside ryco.
    const roots = await resolve({
      projectRoots: [...subprojects, path.join(home, "Code", "ryco")],
    });
    expect(roots.defaultProjectDirectory).toBe(path.join(home, "Code"));
    expect(roots.defaultProjectDirectorySource).toBe("existing-projects");
    expect(roots.codeRoots[0]).toEqual({
      path: path.join(home, "Code"),
      source: "existing-projects",
      projectCount: 3,
    });
    // The repository's inner folder stays a place to search, after the code folders.
    expect(roots.codeRoots.map((root) => root.path)).toEqual([
      path.join(home, "Code"),
      path.join(mono, "packages"),
      home,
    ]);

    // Alone they are one folder: no pattern, so the well-known folder is the default.
    const alone = await resolve({ projectRoots: subprojects });
    expect(alone.defaultProjectDirectory).toBe(path.join(home, "Code"));
    expect(alone.defaultProjectDirectorySource).toBe("well-known");

    // A git worktree file marks a working tree too; a nested repository counts as the outer one.
    const linked = path.join(scratch, "linked");
    await mkdir(path.join(linked, "tools", "a"), { recursive: true });
    await mkdir(path.join(linked, "tools", "b", ".git"), { recursive: true });
    await writeFile(path.join(linked, ".git"), "gitdir: /elsewhere\n");
    const nested = await resolve({
      projectRoots: [path.join(linked, "tools", "a"), path.join(linked, "tools", "b")],
    });
    expect(nested.defaultProjectDirectory).not.toBe(path.join(linked, "tools"));
    expect(nested.codeRoots.find((root) => root.path === path.join(linked, "tools"))?.source).toBe(
      "existing-projects",
    );
  });

  it("does not look past home for the repository a project is in", async () => {
    // A home folder under version control (dotfiles) does not make every project one folder.
    await mkdir(path.join(home, ".git"));
    const work = path.join(home, "work");
    await mkdir(path.join(work, "a"), { recursive: true });
    await mkdir(path.join(work, "b"), { recursive: true });
    const roots = await resolve({ projectRoots: [path.join(work, "a"), path.join(work, "b")] });
    expect(roots.defaultProjectDirectory).toBe(work);
    expect(roots.defaultProjectDirectorySource).toBe("existing-projects");
  });

  it("never picks a folder in a temporary directory as the code folder", async () => {
    await mkdir(path.join(home, "Code"));
    const temporary = path.join(scratch, "tmp");
    // The temporary directory itself, a scratch folder one level below it, and a mkdtemp-style
    // folder deeper down: the OS empties them all.
    for (const folder of [
      temporary,
      path.join(temporary, "scratch"),
      path.join(temporary, "T", "ryco-abc"),
    ]) {
      const roots = await resolve({
        projectRoots: await projectPair(folder),
        temporaryDirectories: [temporary],
      });
      expect(roots.defaultProjectDirectory).toBe(path.join(home, "Code"));
      expect(roots.defaultProjectDirectorySource).toBe("well-known");
      expect(roots.codeRoots[0]?.path).toBe(path.join(home, "Code"));
      // Still a place to search, after the code folders.
      expect(roots.codeRoots.find((root) => root.path === folder)?.source).toBe(
        "existing-projects",
      );
    }

    // Matched by realpath on both sides, as macOS `/tmp` is `/private/tmp`.
    const link = path.join(scratch, "tmp-link");
    await symlink(temporary, link);
    const throughLink = await resolve({
      projectRoots: [path.join(link, "scratch", "a"), path.join(link, "scratch", "b")],
      temporaryDirectories: [temporary],
    });
    expect(throughLink.defaultProjectDirectory).toBe(path.join(home, "Code"));
    const linkedTemporary = await resolve({
      projectRoots: await projectPair(path.join(temporary, "scratch")),
      temporaryDirectories: [link],
    });
    expect(linkedTemporary.defaultProjectDirectory).toBe(path.join(home, "Code"));

    // A folder whose name merely starts with the temporary directory's is not in it.
    const beside = path.join(scratch, "tmp-work");
    const besideRoots = await resolve({
      projectRoots: await projectPair(beside),
      temporaryDirectories: [temporary],
    });
    expect(besideRoots.defaultProjectDirectory).toBe(beside);
    expect(besideRoots.defaultProjectDirectorySource).toBe("existing-projects");
  });

  it("skips a projects folder that no longer exists", async () => {
    const gone = path.join(scratch, "gone");
    const roots = await resolve({ projectRoots: [path.join(gone, "a"), path.join(gone, "b")] });
    expect(roots.defaultProjectDirectory).toBe(home);
    expect(roots.codeRoots.map((root) => root.path)).toEqual([home]);
  });

  it("uses the setting even before it exists, and lists it once it does", async () => {
    await mkdir(path.join(home, "Code"));
    const configured = path.join(scratch, "configured");
    let roots = await resolve({ addProjectBaseDirectory: `  ${configured}  ` });
    expect(roots.defaultProjectDirectory).toBe(configured);
    expect(roots.defaultProjectDirectorySource).toBe("setting");
    expect(roots.codeRoots[0]?.source).toBe("well-known");
    await mkdir(configured);
    roots = await resolve({ addProjectBaseDirectory: configured });
    expect(roots.codeRoots[0]).toEqual({ path: configured, source: "setting", projectCount: 0 });
    // `~` expands against the server's home, as chat promotion always has.
    expect((await resolve({ addProjectBaseDirectory: "~/Projects" })).defaultProjectDirectory).toBe(
      path.join(homedir(), "Projects"),
    );
    // A relative setting is ignored.
    expect((await resolve({ addProjectBaseDirectory: "Projects" })).defaultProjectDirectory).toBe(
      path.join(home, "Code"),
    );
  });

  it("keeps everything inside the access root when restricted", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(path.join(allowed, "inner"), { recursive: true });
    await mkdir(path.join(home, "Code"));
    const roots = await resolve({
      workspaceAccessRoot: allowed,
      addProjectBaseDirectory: path.join(allowed, "inner"),
      projectRoots: [path.join(allowed, "inner", "a"), path.join(allowed, "inner", "b")],
    });
    expect(roots.defaultProjectDirectory).toBe(allowed);
    expect(roots.defaultProjectDirectorySource).toBe("access-root");
    expect(roots.codeRoots).toEqual([
      { path: allowed, source: "access-root", projectCount: 2 },
      { path: path.join(allowed, "inner"), source: "setting", projectCount: 2 },
    ]);
  });

  it("lists one root per real directory", async () => {
    await mkdir(path.join(home, "Code"));
    // `~/dev` is a well-known name too, but the same folder.
    await symlink(path.join(home, "Code"), path.join(home, "dev"));
    const roots = await resolve({
      projectRoots: [path.join(home, "Code", "a"), path.join(home, "Code", "b")],
    });
    expect(roots.codeRoots).toEqual([
      { path: path.join(home, "Code"), source: "existing-projects", projectCount: 2 },
      { path: home, source: "home", projectCount: 2 },
    ]);
  });

  it("keeps home when the list is full", async () => {
    const projectRoots: string[] = [];
    for (let index = 0; index < PROJECT_COPY_MAX_CODE_ROOTS + 2; index += 1) {
      const parent = path.join(scratch, `parent-${index}`);
      await mkdir(parent);
      projectRoots.push(path.join(parent, "a"), path.join(parent, "b"));
    }
    const roots = await resolve({ projectRoots });
    expect(roots.codeRoots).toHaveLength(PROJECT_COPY_MAX_CODE_ROOTS);
    expect(roots.codeRoots.at(-1)).toMatchObject({ path: home, source: "home" });
  });
});
