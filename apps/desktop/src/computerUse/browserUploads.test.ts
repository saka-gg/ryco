import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_UPLOAD_DIR_NAME,
  BROWSER_UPLOAD_QUOTA,
  BROWSER_UPLOAD_REFUSED,
  BrowserUploadStore,
  MAX_RETAINED_UPLOAD_BYTES_PER_TAB,
  MAX_RETAINED_UPLOADS_PER_TAB,
  ORPHAN_UPLOAD_AGE_MS,
  ORPHAN_SWEEP_INTERVAL_MS,
  settleBrowserUpload,
} from "./browserUploads.ts";

const temporary: string[] = [];
const stores: BrowserUploadStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function stateDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-uploads-state-")));
  temporary.push(directory);
  return directory;
}

async function newStore(stateDir = stateDirectory(), options = {}) {
  const store = await BrowserUploadStore.create(stateDir, options);
  stores.push(store);
  return store;
}

let ids = 0;
/** A fresh id in the server's format (`newBrowserUploadId`). */
const nextId = () => `u-${(++ids).toString(16).padStart(16, "0")}`;
/** Lays out an upload the way the server stages it: `<root>/<id>/<index>/<name>`. */
function stage(
  store: BrowserUploadStore,
  sizes: readonly number[] = [12],
  uploadId = nextId(),
): { uploadId: string; dir: string; files: string[] } {
  const dir = path.join(store.root, uploadId);
  const files = sizes.map((size, index) => {
    fs.mkdirSync(path.join(dir, String(index)), { recursive: true, mode: 0o700 });
    const file = path.join(dir, String(index), `file-${index}.txt`);
    fs.writeFileSync(file, "", { mode: 0o600 });
    // Sparse: the quotas count the logical size without writing gigabytes.
    fs.truncateSync(file, size);
    return file;
  });
  return { uploadId, dir, files };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: Error) => error.message,
  );
}

describe("BrowserUploadStore.create", () => {
  it("moves an earlier run's directory aside and returns before it is deleted", async () => {
    const stateDir = stateDirectory();
    const leftover = path.join(stateDir, BROWSER_UPLOAD_DIR_NAME, "u-old123", "0");
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "big.bin"), "x");
    fs.mkdirSync(path.join(stateDir, `${BROWSER_UPLOAD_DIR_NAME}.stale-1-1`));
    const removeTree = vi.fn((_path: string) => new Promise<void>(() => {}));
    const store = await newStore(stateDir, { removeTree });
    expect(store.root).toBe(path.join(stateDir, BROWSER_UPLOAD_DIR_NAME));
    expect(fs.readdirSync(store.root)).toEqual([]);
    expect(fs.statSync(store.root).mode & 0o777).toBe(0o700);
    // Both stale trees go in the background (this removeTree never finishes).
    await vi.waitFor(() => expect(removeTree).toHaveBeenCalledTimes(2));
    const removed = removeTree.mock.calls.map(([target]) => path.basename(target)).toSorted();
    expect(removed[0]).toBe(`${BROWSER_UPLOAD_DIR_NAME}.stale-1-1`);
    expect(removed[1]).toMatch(new RegExp(`^${BROWSER_UPLOAD_DIR_NAME}\\.stale-${process.pid}-`));
    expect(fs.existsSync(path.join(stateDir, removed[1]!, "u-old123", "0", "big.bin"))).toBe(true);
  });

  it("deletes the stale trees by default", async () => {
    const stateDir = stateDirectory();
    fs.mkdirSync(path.join(stateDir, BROWSER_UPLOAD_DIR_NAME, "u-old123"), { recursive: true });
    await newStore(stateDir);
    await vi.waitFor(() => expect(fs.readdirSync(stateDir)).toEqual([BROWSER_UPLOAD_DIR_NAME]));
  });

  it("sweeps every 5 minutes until disposed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const store = await newStore();
    const sweep = vi.spyOn(store, "sweep");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(ORPHAN_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("BrowserUploadStore.resolve", () => {
  it("accepts the server's layout and reports the files' own names", async () => {
    const store = await newStore();
    const { uploadId, dir, files } = stage(store, [12, 7]);
    await expect(store.resolve("1", uploadId, files)).resolves.toEqual({
      tab: "1",
      dir,
      files,
      names: ["file-0.txt", "file-1.txt"],
      bytes: 19,
    });
  });

  it("refuses anything but regular files of the upload's own slots, and removes the upload", async () => {
    const store = await newStore();
    const outside = path.join(stateDirectory(), "secret.txt");
    fs.writeFileSync(outside, "secret");
    const cases: Array<(upload: ReturnType<typeof stage>) => unknown> = [
      () => [outside],
      ({ dir }) => [`${dir}/0/../0/file-0.txt`], // Not normalized.
      ({ dir }) => [path.join(dir, "file.txt")],
      ({ dir, files }) => {
        fs.mkdirSync(path.join(dir, "1"));
        fs.copyFileSync(files[0]!, path.join(dir, "1", "file-1.txt"));
        return [path.join(dir, "1", "file-1.txt")]; // Not the slot of index 0.
      },
      ({ dir }) => {
        fs.symlinkSync(outside, path.join(dir, "0", "link.txt"));
        return [path.join(dir, "0", "link.txt")];
      },
      ({ dir }) => {
        fs.linkSync(outside, path.join(dir, "0", "hard.txt"));
        return [path.join(dir, "0", "hard.txt")];
      },
      ({ dir }) => [path.join(dir, "0")],
      () => [],
      ({ files }) => Array.from({ length: 33 }, () => files[0]),
      ({ files }) => files[0],
      () => [42],
    ];
    for (const files of cases) {
      const upload = stage(store);
      expect(await refusal(store.resolve("1", upload.uploadId, files(upload)))).toBe(
        BROWSER_UPLOAD_REFUSED,
      );
      expect(fs.existsSync(upload.dir)).toBe(false);
    }
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("refuses ids that are not the server's and never removes anything outside its directory", async () => {
    const stateDir = stateDirectory();
    const store = await newStore(stateDir);
    fs.mkdirSync(path.join(stateDir, "x"));
    const upload = stage(store);
    // Node's mkdtemp suffix (the old format) is not the server's id either.
    for (const uploadId of ["../x", "u-abc", "u-abcdef", "u-abcdefg", "x", 7, undefined])
      expect(await refusal(store.resolve("1", uploadId, upload.files))).toBe(
        BROWSER_UPLOAD_REFUSED,
      );
    expect(fs.existsSync(path.join(stateDir, "x"))).toBe(true);
    // A directory that is a link is refused (and the link removed, not its target).
    const target = path.join(stateDir, "target");
    fs.mkdirSync(target);
    const linked = nextId();
    fs.symlinkSync(target, path.join(store.root, linked));
    expect(await refusal(store.resolve("1", linked, []))).toBe(BROWSER_UPLOAD_REFUSED);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(store.root, linked))).toBe(false);
  });

  it("refuses an id a page or request already holds without removing its files", async () => {
    const store = await newStore();
    const upload = stage(store);
    const resolved = await store.resolve("1", upload.uploadId, upload.files);
    expect(await refusal(store.resolve("1", upload.uploadId, upload.files))).toBe(
      BROWSER_UPLOAD_REFUSED,
    );
    store.retain(resolved);
    expect(await refusal(store.resolve("2", upload.uploadId, upload.files))).toBe(
      BROWSER_UPLOAD_REFUSED,
    );
    expect(fs.existsSync(upload.files[0]!)).toBe(true);
  });

  it("holds each tab to its quota and all tabs to the total", async () => {
    const store = await newStore();
    const retain = async (tab: string, sizes: number[]) => {
      const upload = stage(store, sizes);
      store.retain(await store.resolve(tab, upload.uploadId, upload.files));
    };
    await retain("1", [MAX_RETAINED_UPLOAD_BYTES_PER_TAB]);
    const over = stage(store, [1]);
    expect(await refusal(store.resolve("1", over.uploadId, over.files))).toBe(BROWSER_UPLOAD_QUOTA);
    expect(fs.existsSync(over.dir)).toBe(false);
    // Other tabs share 2 GiB in total.
    await retain("2", [MAX_RETAINED_UPLOAD_BYTES_PER_TAB]);
    await retain("3", [MAX_RETAINED_UPLOAD_BYTES_PER_TAB]);
    await retain("4", [MAX_RETAINED_UPLOAD_BYTES_PER_TAB]);
    const total = stage(store, [1]);
    expect(await refusal(store.resolve("5", total.uploadId, total.files))).toBe(
      BROWSER_UPLOAD_QUOTA,
    );
    // Navigating tab 1 frees its share.
    await store.releaseTab("1");
    const fits = stage(store, [1]);
    await expect(store.resolve("5", fits.uploadId, fits.files)).resolves.toMatchObject({
      bytes: 1,
    });
  });

  it("counts uploads and files per tab", async () => {
    const store = await newStore();
    for (let index = 0; index < MAX_RETAINED_UPLOADS_PER_TAB; index += 1) {
      const upload = stage(store, [1]);
      store.retain(await store.resolve("1", upload.uploadId, upload.files));
    }
    const extra = stage(store, [1]);
    expect(await refusal(store.resolve("1", extra.uploadId, extra.files))).toBe(
      BROWSER_UPLOAD_QUOTA,
    );
    // 16 uploads of 32 files reach the 512-file limit before the upload count does.
    for (let index = 0; index < 16; index += 1) {
      const upload = stage(
        store,
        Array.from({ length: 32 }, () => 1),
      );
      store.retain(await store.resolve("2", upload.uploadId, upload.files));
    }
    const more = stage(store, [1]);
    expect(await refusal(store.resolve("2", more.uploadId, more.files))).toBe(BROWSER_UPLOAD_QUOTA);
  });

  it("sweeps orphans before it validates", async () => {
    let now = Date.now();
    const store = await newStore(undefined, { now: () => now });
    const orphan = stage(store);
    now += ORPHAN_UPLOAD_AGE_MS + 1_000;
    const upload = stage(store);
    // A fresh upload's directory is young, so only the orphan goes.
    const old = new Date(Date.now() - ORPHAN_UPLOAD_AGE_MS - 60_000);
    fs.utimesSync(orphan.dir, old, old);
    const recent = new Date(now);
    fs.utimesSync(upload.dir, recent, recent);
    await store.resolve("1", upload.uploadId, upload.files);
    expect(fs.existsSync(orphan.dir)).toBe(false);
    expect(fs.existsSync(upload.dir)).toBe(true);
  });
});

describe("BrowserUploadStore lifecycle", () => {
  it("settles an upload no page kept, keeps a retained one and ignores ids that are not its own", async () => {
    const stateDir = stateDirectory();
    const store = await newStore(stateDir);
    const dropped = stage(store);
    await store.resolve("1", dropped.uploadId, dropped.files);
    await store.settle(dropped.uploadId);
    expect(fs.existsSync(dropped.dir)).toBe(false);
    // Copies that never reached resolve (a refusal before it) go too.
    const early = stage(store);
    await store.settle(early.uploadId);
    expect(fs.existsSync(early.dir)).toBe(false);
    const kept = stage(store);
    store.retain(await store.resolve("1", kept.uploadId, kept.files));
    await store.settle(kept.uploadId);
    expect(fs.existsSync(kept.dir)).toBe(true);
    fs.mkdirSync(path.join(stateDir, "x"));
    for (const uploadId of ["../x", "..", "", 3, null]) await store.settle(uploadId);
    expect(fs.existsSync(path.join(stateDir, "x"))).toBe(true);
    expect(fs.existsSync(store.root)).toBe(true);
  });

  it("releases only the tab whose page navigated or closed", async () => {
    const store = await newStore();
    const first = stage(store);
    const second = stage(store);
    const other = stage(store);
    store.retain(await store.resolve("1", first.uploadId, first.files));
    store.retain(await store.resolve("1", second.uploadId, second.files));
    store.retain(await store.resolve("2", other.uploadId, other.files));
    await store.releaseTab("1");
    expect(fs.existsSync(first.dir)).toBe(false);
    expect(fs.existsSync(second.dir)).toBe(false);
    expect(fs.existsSync(other.dir)).toBe(true);
  });

  it("does not keep copies for a page that went away while the upload ran", async () => {
    const store = await newStore();
    const upload = stage(store);
    const resolved = await store.resolve("1", upload.uploadId, upload.files);
    await store.releaseTab("1");
    store.retain(resolved);
    await vi.waitFor(() => expect(fs.existsSync(upload.dir)).toBe(false));
    // A later settle has nothing to do and does not throw.
    await expect(store.settle(upload.uploadId)).resolves.toBeUndefined();
  });

  it("discards only unretained uploads inside its directory", async () => {
    const stateDir = stateDirectory();
    const store = await newStore(stateDir);
    const kept = stage(store);
    store.retain(await store.resolve("1", kept.uploadId, kept.files));
    await store.discard(kept.dir);
    expect(fs.existsSync(kept.dir)).toBe(true);
    const outside = path.join(stateDir, nextId());
    fs.mkdirSync(outside);
    await store.discard(outside);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("sweeps only unheld directories older than 5 minutes", async () => {
    const store = await newStore();
    const now = Date.now();
    const age = (dir: string, ms: number) => {
      const time = new Date(now - ms);
      fs.utimesSync(dir, time, time);
    };
    const orphan = stage(store);
    const young = stage(store);
    const retained = stage(store);
    const inflight = stage(store);
    store.retain(await store.resolve("1", retained.uploadId, retained.files));
    await store.resolve("1", inflight.uploadId, inflight.files);
    age(orphan.dir, ORPHAN_UPLOAD_AGE_MS + 1_000);
    age(young.dir, ORPHAN_UPLOAD_AGE_MS - 60_000);
    age(retained.dir, ORPHAN_UPLOAD_AGE_MS * 10);
    age(inflight.dir, ORPHAN_UPLOAD_AGE_MS * 10);
    await store.sweep(now);
    expect(fs.existsSync(orphan.dir)).toBe(false);
    expect(fs.existsSync(young.dir)).toBe(true);
    expect(fs.existsSync(retained.dir)).toBe(true);
    expect(fs.existsSync(inflight.dir)).toBe(true);
  });
});

describe("settleBrowserUpload", () => {
  it("settles the upload a browser request carried, and nothing else", () => {
    const uploads = { settle: vi.fn(async (_uploadId: unknown) => undefined) };
    const uploadId = nextId();
    settleBrowserUpload({ tool: "browser", args: { action: "upload", uploadId } }, uploads);
    expect(uploads.settle).toHaveBeenCalledWith(uploadId);
    settleBrowserUpload({ tool: "browser", args: { action: "click" } }, uploads);
    settleBrowserUpload({ tool: "computer", args: { uploadId } }, uploads);
    expect(uploads.settle).toHaveBeenCalledTimes(1);
    // A desktop without an upload directory has nothing to settle.
    expect(() => settleBrowserUpload({ tool: "browser", args: { uploadId } }, null)).not.toThrow();
  });
});
