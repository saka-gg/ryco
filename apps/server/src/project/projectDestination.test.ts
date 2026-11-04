import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  firstFreeDestination,
  foldPathCase,
  locateDestination,
  parseDestinationPath,
} from "./projectDestination.ts";

let scratch: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-destination-")));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("parseDestinationPath", () => {
  const posix = (raw: string) =>
    parseDestinationPath(raw, { homeDir: "/home/ada", platform: "linux" });
  const windows = (raw: string) =>
    parseDestinationPath(raw, { homeDir: "C:\\Users\\ada", platform: "win32" });

  it("accepts absolute POSIX paths and expands only ~ and ~/", () => {
    expect(posix("/srv/code/app")).toBe("/srv/code/app");
    expect(posix("  /srv/code/app/  ")).toBe("/srv/code/app");
    expect(posix("/srv/code/../app")).toBe("/srv/app");
    expect(posix("~")).toBe("/home/ada");
    expect(posix("~/")).toBe("/home/ada");
    expect(posix("~/Code/app")).toBe("/home/ada/Code/app");
  });

  it("never resolves anything else against the working directory", () => {
    for (const raw of [
      "",
      "   ",
      "app",
      "./app",
      "../app",
      "~ada/Code",
      "~\\Code",
      "C:\\Code",
      "\\\\server\\share\\app",
      "/srv/a\u0000b",
      "/srv/a\nb",
    ]) {
      expect(posix(raw), raw).toBeNull();
    }
  });

  it("accepts Windows drive and UNC paths on Windows only", () => {
    expect(windows("C:\\Code\\app")).toBe("C:\\Code\\app");
    expect(windows("c:/Code/app/")).toBe("c:\\Code\\app");
    expect(windows("\\\\server\\share\\app")).toBe("\\\\server\\share\\app");
    expect(windows("~")).toBe("C:\\Users\\ada");
    expect(windows("~\\Code")).toBe("C:\\Users\\ada\\Code");
    expect(windows("~/Code")).toBe("C:\\Users\\ada\\Code");
    for (const raw of ["C:Code", "\\Code", "/Code", "Code", "~ada\\Code", "\\\\server"]) {
      expect(windows(raw), raw).toBeNull();
    }
  });
});

describe("foldPathCase", () => {
  it("folds only on case-insensitive volumes", () => {
    expect(foldPathCase("/Users/Ada/Code", "darwin")).toBe("/users/ada/code");
    expect(foldPathCase("C:\\Code", "win32")).toBe("c:\\code");
    expect(foldPathCase("/home/Ada/Code", "linux")).toBe("/home/Ada/Code");
  });
});

describe("firstFreeDestination", () => {
  it("returns the base, else the first free numbered sibling", async () => {
    const base = path.join(scratch, "app");
    expect(await firstFreeDestination(base)).toBe(base);
    await mkdir(base);
    await writeFile(`${base}-2`, "taken by a file");
    // A broken symlink is taken too.
    await symlink(path.join(scratch, "nowhere"), `${base}-3`);
    expect(await firstFreeDestination(base)).toBe(`${base}-4`);
    expect(await firstFreeDestination(path.join(scratch, "free"), { skipBase: true })).toBe(
      path.join(scratch, "free-2"),
    );
  });

  it("gives up when the parent cannot be read", async () => {
    const file = path.join(scratch, "file");
    await writeFile(file, "not a folder");
    expect(await firstFreeDestination(path.join(file, "app"))).toBeNull();
  });
});

describe("locateDestination", () => {
  const locate = (raw: string, options: { accessRoot?: string; fenced?: string } = {}) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* makeWorkspaceAccessPolicy(options.accessRoot);
        return yield* locateDestination({
          raw,
          homeDir: scratch,
          policy,
          operation: "test",
          excludedRoots: [{ root: path.join(scratch, "chats"), reason: "inside-chats" as const }],
          fenced: (canonical) =>
            Effect.succeed(canonical === options.fenced ? ("retired" as const) : null),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  it("locates through symlinked parents and reports what is already there", async () => {
    await mkdir(path.join(scratch, "real", "taken"), { recursive: true });
    await symlink(path.join(scratch, "real"), path.join(scratch, "link"));
    expect(await locate("~/link/new")).toEqual({
      status: "located",
      destination: path.join(scratch, "link", "new"),
      canonical: path.join(scratch, "real", "new"),
      leafExists: false,
    });
    expect(await locate(path.join(scratch, "link", "taken"))).toMatchObject({
      status: "located",
      canonical: path.join(scratch, "real", "taken"),
      leafExists: true,
    });
  });

  it("refuses roots, relative paths, excluded folders, fenced paths and the policy's outside", async () => {
    await mkdir(path.join(scratch, "allowed"));
    await mkdir(path.join(scratch, "chats"));
    expect(await locate("/")).toMatchObject({ status: "invalid", destination: "/" });
    expect(await locate(" relative/app ")).toEqual({
      status: "invalid",
      destination: "relative/app",
    });
    expect(await locate(path.join(scratch, "chats", "x"))).toMatchObject({
      status: "excluded",
      reason: "inside-chats",
    });
    expect(
      await locate(path.join(scratch, "fenced"), { fenced: path.join(scratch, "fenced") }),
    ).toMatchObject({ status: "fenced", verdict: "retired" });
    expect(
      await locate(path.join(scratch, "elsewhere"), { accessRoot: path.join(scratch, "allowed") }),
    ).toMatchObject({ status: "access-denied" });
    // A symlink inside the allowed root that leads out of it.
    await symlink(scratch, path.join(scratch, "allowed", "escape"));
    expect(
      await locate(path.join(scratch, "allowed", "escape", "x"), {
        accessRoot: path.join(scratch, "allowed"),
      }),
    ).toMatchObject({ status: "access-denied" });
  });

  it("reports a broken symlink on the way as unresolvable", async () => {
    await symlink(path.join(scratch, "nowhere"), path.join(scratch, "dangling"));
    expect(await locate(path.join(scratch, "dangling"))).toMatchObject({
      status: "unresolvable",
      leafExists: true,
    });
    expect(await locate(path.join(scratch, "dangling", "child"))).toMatchObject({
      status: "unresolvable",
      leafExists: false,
    });
  });
});
