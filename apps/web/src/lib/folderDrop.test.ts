import { describe, expect, it, vi } from "vite-plus/test";

import { isFileDrag, readDroppedFolderCandidate } from "./folderDrop";

const folder = new File([], "dropped");
const textFile = new File(["notes"], "notes.txt", { type: "text/plain" });

function item(file: File, isDirectory: boolean) {
  return {
    kind: "file",
    getAsFile: vi.fn(() => file),
    webkitGetAsEntry: vi.fn(() => ({ isDirectory })),
  };
}

describe("isFileDrag", () => {
  it("accepts drags that carry files only", () => {
    expect(isFileDrag({ dataTransfer: { types: ["Files"] } })).toBe(true);
    expect(isFileDrag({ dataTransfer: { types: ["text/plain", "text/uri-list"] } })).toBe(false);
    expect(isFileDrag({ dataTransfer: null })).toBe(false);
  });
});

describe("readDroppedFolderCandidate", () => {
  it("reads a directory entry as a folder", () => {
    expect(readDroppedFolderCandidate({ items: [item(folder, true)], files: [folder] })).toEqual({
      kind: "folder",
      file: folder,
    });
  });

  it("reads a file entry as not a folder", () => {
    expect(
      readDroppedFolderCandidate({ items: [item(textFile, false)], files: [textFile] }),
    ).toEqual({ kind: "notFolder" });
  });

  it("treats an item without directory identity as not a folder", () => {
    const plain = { kind: "file", getAsFile: () => textFile };
    expect(readDroppedFolderCandidate({ items: [plain], files: [textFile] })).toEqual({
      kind: "notFolder",
    });
  });

  it("finds nothing without file items", () => {
    const text = { kind: "string", getAsFile: () => null };
    expect(readDroppedFolderCandidate({ items: [text], files: [] })).toEqual({ kind: "none" });
    expect(readDroppedFolderCandidate({ items: [], files: [] })).toEqual({ kind: "none" });
  });

  it("reads only the first of several file items", () => {
    const first = item(folder, true);
    const second = item(textFile, false);
    expect(
      readDroppedFolderCandidate({ items: [first, second], files: [folder, textFile] }),
    ).toEqual({ kind: "folder", file: folder });
    expect(second.webkitGetAsEntry).not.toHaveBeenCalled();
    expect(second.getAsFile).not.toHaveBeenCalled();
  });

  it("falls back to the file list when the item has no file", () => {
    const entryOnly = { ...item(folder, true), getAsFile: () => null };
    expect(readDroppedFolderCandidate({ items: [entryOnly], files: [folder] })).toEqual({
      kind: "folder",
      file: folder,
    });
  });
});
