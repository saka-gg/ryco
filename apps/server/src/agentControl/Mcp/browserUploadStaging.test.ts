import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isBrowserUploadId } from "@ryco/shared/browserUpload";
import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_UPLOAD_BUSY,
  BROWSER_UPLOAD_MAX_BYTES,
  BROWSER_UPLOAD_REFUSED,
  BrowserUploadRefused,
  makeUploadBudget,
  stageBrowserUpload,
} from "./browserUploadStaging.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

/** A canonical private directory, like the desktop's upload root. */
function privateDirectory(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporary.push(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function setup() {
  const uploadDir = privateDirectory("ryco-browser-uploads-");
  const workspace = privateDirectory("ryco-browser-workspace-");
  fs.writeFileSync(path.join(workspace, "a.txt"), "hello upload");
  fs.mkdirSync(path.join(workspace, "sub"));
  fs.writeFileSync(path.join(workspace, "sub", "b.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const stage = (
    paths: unknown,
    extra: { maxBytes?: number; limitBytes?: number; uploadDir?: string } = {},
  ) => stageBrowserUpload({ uploadDir, cwd: workspace, paths, ...extra });
  return { uploadDir, workspace, stage };
}

async function expectRefused(
  promise: Promise<unknown>,
  reason: string = BROWSER_UPLOAD_REFUSED,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(BrowserUploadRefused);
  expect((error as BrowserUploadRefused).reason).toBe(reason);
}

describe("stageBrowserUpload", () => {
  it("copies workspace files into one private directory per file, under their own names", async () => {
    const { uploadDir, workspace, stage } = setup();
    const staged = await stage(["a.txt", "sub/b.png"]);
    // The id format the desktop accepts (shared), not Node's mkdtemp suffix.
    expect(isBrowserUploadId(staged.uploadId)).toBe(true);
    const directory = path.join(uploadDir, staged.uploadId);
    expect(staged.files).toEqual([
      { path: path.join(directory, "0", "a.txt"), name: "a.txt", sizeBytes: 12 },
      { path: path.join(directory, "1", "b.png"), name: "b.png", sizeBytes: 7 },
    ]);
    expect(staged.bytes).toBe(19);
    for (const [index, relative] of ["a.txt", "sub/b.png"].entries())
      expect(fs.readFileSync(staged.files[index]!.path)).toEqual(
        fs.readFileSync(path.join(workspace, relative)),
      );
    // Copies, never links to the workspace; closed to other users.
    expect(fs.lstatSync(staged.files[0]!.path).isFile()).toBe(true);
    expect(fs.statSync(staged.files[0]!.path).ino).not.toBe(
      fs.statSync(path.join(workspace, "a.txt")).ino,
    );
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(staged.files[0]!.path).mode & 0o077).toBe(0);
    // No staging leftovers next to the slots.
    expect(fs.readdirSync(directory).toSorted()).toEqual(["0", "1"]);
  });

  it.each([
    ["an absolute path", (workspace: string) => [path.join(workspace, "a.txt")]],
    ["a parent traversal", () => ["../x"]],
    ["a directory", () => ["sub"]],
    ["a missing file", () => ["missing.txt"]],
    ["duplicates", () => ["a.txt", "a.txt"]],
    ["33 paths", () => Array.from({ length: 33 }, (_, index) => `f${index}.txt`)],
    ["no paths", () => []],
    ["a non-array", () => "a.txt"],
    ["an empty path", () => [""]],
  ])("refuses %s and leaves nothing behind", async (_name, paths) => {
    const { uploadDir, workspace, stage } = setup();
    for (let index = 0; index < 33; index += 1)
      fs.writeFileSync(path.join(workspace, `f${index}.txt`), "x");
    await expectRefused(stage(paths(workspace)));
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("refuses links, hard links and empty files", async () => {
    const { uploadDir, workspace, stage } = setup();
    const secret = privateDirectory("ryco-browser-secret-");
    fs.writeFileSync(path.join(secret, "id_rsa"), "private key");
    fs.symlinkSync(path.join(secret, "id_rsa"), path.join(workspace, "link.txt"));
    fs.symlinkSync(secret, path.join(workspace, "linked-dir"));
    fs.linkSync(path.join(secret, "id_rsa"), path.join(workspace, "hard.txt"));
    fs.writeFileSync(path.join(workspace, "empty.txt"), "");
    for (const paths of [
      ["link.txt"],
      ["linked-dir/id_rsa"],
      ["hard.txt"],
      ["empty.txt"],
      ["a.txt", "link.txt"],
    ]) {
      await expectRefused(stage(paths));
      expect(fs.readdirSync(uploadDir)).toEqual([]);
    }
  });

  it("refuses more bytes than one upload may stage, counting every file", async () => {
    const { uploadDir, stage } = setup();
    await expectRefused(stage(["a.txt", "sub/b.png"], { maxBytes: 18, limitBytes: 18 }));
    expect(fs.readdirSync(uploadDir)).toEqual([]);
    await expect(stage(["a.txt", "sub/b.png"], { limitBytes: 19 })).resolves.toMatchObject({
      bytes: 19,
    });
    // A larger limit than one upload's maximum is capped at it.
    await expect(
      stage(["a.txt"], { maxBytes: BROWSER_UPLOAD_MAX_BYTES * 4 }),
    ).resolves.toMatchObject({ bytes: 12 });
  });

  it("says busy, not refused, when only other uploads' reservations are in the way", async () => {
    const { uploadDir, workspace, stage } = setup();
    // The second file fits one upload's limit but not what the budget granted now.
    await expectRefused(stage(["a.txt", "sub/b.png"], { maxBytes: 18 }), BROWSER_UPLOAD_BUSY);
    expect(fs.readdirSync(uploadDir)).toEqual([]);
    await expectRefused(stage(["a.txt"], { maxBytes: 0, limitBytes: 100 }), BROWSER_UPLOAD_BUSY);
    // An empty file, or one over the limit, stays refused whatever the budget.
    fs.writeFileSync(path.join(workspace, "empty.txt"), "");
    await expectRefused(stage(["empty.txt"], { maxBytes: 5 }));
    await expectRefused(stage(["a.txt"], { maxBytes: 5, limitBytes: 11 }));
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("refuses an upload directory other users can read", async () => {
    const { uploadDir, stage } = setup();
    fs.chmodSync(uploadDir, 0o755);
    await expectRefused(stage(["a.txt"]));
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("refuses an upload directory reached through a link", async () => {
    const { uploadDir, stage } = setup();
    const parent = privateDirectory("ryco-browser-link-");
    const link = path.join(parent, "uploads");
    fs.symlinkSync(uploadDir, link);
    await expectRefused(stage(["a.txt"], { uploadDir: link }));
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("refuses a workspace that contains the upload directory, or lies inside it", async () => {
    const { workspace } = setup();
    fs.writeFileSync(path.join(workspace, "c.txt"), "inside");
    const inside = path.join(workspace, "uploads");
    fs.mkdirSync(inside, { mode: 0o700 });
    await expectRefused(
      stageBrowserUpload({ uploadDir: inside, cwd: workspace, paths: ["c.txt"] }),
    );
    expect(fs.readdirSync(inside)).toEqual([]);
    await expectRefused(stageBrowserUpload({ uploadDir: workspace, cwd: inside, paths: ["x"] }));
    await expectRefused(
      stageBrowserUpload({ uploadDir: workspace, cwd: workspace, paths: ["c.txt"] }),
    );
  });

  it("stops and cleans up when aborted", async () => {
    const { uploadDir, workspace, stage } = setup();
    const controller = new AbortController();
    controller.abort();
    await expectRefused(
      stageBrowserUpload({
        uploadDir,
        cwd: workspace,
        paths: ["a.txt"],
        signal: controller.signal,
      }),
    );
    expect(fs.readdirSync(uploadDir)).toEqual([]);
    await expect(stage(["a.txt"])).resolves.toBeDefined();
  });
});

describe("makeUploadBudget", () => {
  it("reserves one upload's maximum, shrinks to what was staged and releases once", () => {
    const budget = makeUploadBudget(BROWSER_UPLOAD_MAX_BYTES + 100);
    const first = budget.reserve();
    expect(first?.maxBytes).toBe(BROWSER_UPLOAD_MAX_BYTES);
    // A concurrent upload gets only what is left, so together they never exceed the limit.
    const second = budget.reserve();
    expect(second?.maxBytes).toBe(100);
    // What it could get alone, so a file between the two is busy rather than refused.
    expect(second?.limitBytes).toBe(BROWSER_UPLOAD_MAX_BYTES);
    expect(budget.reserve()).toBeUndefined();
    first!.shrink(40);
    expect(budget.outstanding()).toBe(140);
    first!.release();
    first!.release();
    expect(budget.outstanding()).toBe(100);
    second!.release();
    expect(budget.outstanding()).toBe(0);
    expect(budget.reserve()?.maxBytes).toBe(BROWSER_UPLOAD_MAX_BYTES);
    expect(makeUploadBudget(10).reserve()).toMatchObject({ maxBytes: 10, limitBytes: 10 });
  });
});
