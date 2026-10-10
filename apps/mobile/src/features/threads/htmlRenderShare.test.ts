import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The page share, with expo-file-system and React Native's share sheet faked by
// an in-memory file tree. What it proves: the sheet gets a cache file named
// after the page holding exactly the page, the copy is gone once the sheet
// closes (also when sharing fails), and a copy an earlier share left behind is
// cleared first.

const hoisted = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  share: vi.fn(async (_content: { url?: string }) => ({ action: "sharedAction" })),
  writeFails: false,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Share: { share: hoisted.share },
}));

vi.mock("expo-file-system", () => {
  const { files, directories } = hoisted;
  const uriOf = (parts: ReadonlyArray<string | { uri: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return directories.has(this.uri);
    }
    create() {
      directories.add(this.uri);
    }
    delete() {
      directories.delete(this.uri);
      for (const uri of files.keys()) {
        if (uri.startsWith(`${this.uri}/`)) files.delete(uri);
      }
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    write(content: string) {
      if (hoisted.writeFails) throw new Error("disk full");
      files.set(this.uri, content);
    }
  }
  return { Directory, File, Paths: { cache: { uri: "file:///cache" } } };
});

import { HTML_RENDER_SHARE_SUPPORTED, shareHtmlRender } from "./htmlRenderShare";

const SHARED_URI = "file:///cache/html-render-share/Bundle size.html";

beforeEach(() => {
  hoisted.files.clear();
  hoisted.directories.clear();
  hoisted.share.mockClear();
  hoisted.writeFails = false;
});

describe("shareHtmlRender", () => {
  it("shares a cache file named after the page, holding the page", async () => {
    let sharedContent: string | undefined;
    hoisted.share.mockImplementationOnce(async (content) => {
      sharedContent = hoisted.files.get(content.url ?? "");
      return { action: "sharedAction" };
    });
    await shareHtmlRender({ html: "<p>chart</p>", title: "Bundle size" });
    expect(hoisted.share).toHaveBeenCalledWith({ url: SHARED_URI });
    expect(sharedContent).toBe("<p>chart</p>");
  });

  it("deletes the copy once the sheet closes, also when sharing fails", async () => {
    await shareHtmlRender({ html: "<p>chart</p>", title: "Bundle size" });
    expect(hoisted.files.size).toBe(0);
    expect(hoisted.directories.size).toBe(0);

    hoisted.share.mockRejectedValueOnce(new Error("no sheet"));
    await expect(shareHtmlRender({ html: "<p>chart</p>", title: "Bundle size" })).rejects.toThrow(
      "no sheet",
    );
    expect(hoisted.files.size).toBe(0);
  });

  it("clears a copy an earlier share left behind", async () => {
    hoisted.directories.add("file:///cache/html-render-share");
    hoisted.files.set("file:///cache/html-render-share/Old page.html", "<p>old</p>");
    let filesWhileSharing: string[] = [];
    hoisted.share.mockImplementationOnce(async () => {
      filesWhileSharing = [...hoisted.files.keys()];
      return { action: "dismissedAction" };
    });
    await shareHtmlRender({ html: "<p>new</p>", title: "Bundle size" });
    expect(filesWhileSharing).toEqual([SHARED_URI]);
  });

  it("opens no sheet when the copy cannot be written", async () => {
    hoisted.writeFails = true;
    await expect(shareHtmlRender({ html: "<p>chart</p>", title: "Bundle size" })).rejects.toThrow(
      "disk full",
    );
    expect(hoisted.share).not.toHaveBeenCalled();
    expect(hoisted.directories.size).toBe(0);
  });

  it("names the file safely whatever the title", async () => {
    await shareHtmlRender({ html: "<p>x</p>", title: "../../etc/passwd" });
    expect(hoisted.share).toHaveBeenCalledWith({
      url: "file:///cache/html-render-share/.. .. etc passwd.html",
    });
  });

  it("is offered where the share sheet carries files", () => {
    expect(HTML_RENDER_SHARE_SUPPORTED).toBe(true);
  });
});
