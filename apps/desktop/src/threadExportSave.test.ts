import { describe, expect, it, vi } from "vitest";
import { saveThreadExport } from "./threadExportSave.ts";
const input = { filename: "ryco-conversation.md", contents: "# Retained conversation\n" };
describe("desktop export save", () => {
  it("writes exact contents only to the chosen path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    expect(
      await saveThreadExport(input, { choose: async () => "/chosen/export.md", write }),
    ).toEqual({ status: "saved" });
    expect(write).toHaveBeenCalledWith("/chosen/export.md", input.contents);
  });
  it("cancels without writing", async () => {
    const write = vi.fn();
    expect(await saveThreadExport(input, { choose: async () => null, write })).toEqual({
      status: "cancelled",
    });
    expect(write).not.toHaveBeenCalled();
  });
  it("propagates write failures", async () => {
    await expect(
      saveThreadExport(input, {
        choose: async () => "/chosen/export.md",
        write: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });
  it.each(["../../file.md", "ryco-export.exe", "ryco-a/b.md"])(
    "rejects invalid filename %s",
    async (filename) => {
      const choose = vi.fn();
      await expect(
        saveThreadExport({ ...input, filename }, { choose, write: vi.fn() }),
      ).rejects.toThrow("Invalid");
      expect(choose).not.toHaveBeenCalled();
    },
  );
});
