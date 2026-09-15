import type { DesktopThreadExportInput, DesktopThreadExportResult } from "@ryco/contracts";

export async function saveThreadExport(
  raw: unknown,
  deps: {
    choose: (filename: string) => Promise<string | null>;
    write: (path: string, contents: string) => Promise<void>;
  },
): Promise<DesktopThreadExportResult> {
  if (!raw || typeof raw !== "object") throw new Error("Invalid thread export.");
  const { filename, contents } = raw as Partial<DesktopThreadExportInput>;
  if (
    typeof filename !== "string" ||
    !/^ryco-[a-zA-Z0-9_-]{1,80}\.md$/.test(filename) ||
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") > 32 * 1024 * 1024
  )
    throw new Error("Invalid or oversized thread export.");
  const path = await deps.choose(filename);
  if (path === null) return { status: "cancelled" };
  await deps.write(path, contents);
  return { status: "saved" };
}
