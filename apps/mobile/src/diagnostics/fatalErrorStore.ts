import type { FatalErrorStore } from "./fatalErrorRecorder";

/**
 * The records' file, `<documents>/diagnostics/fatal-errors.json`. `expo-file-system` loads
 * through a function-scoped require, at the first crash or when Diagnostics opens, never at
 * launch. Ordinary app storage: device backups can include it, like the rest of the app's
 * documents.
 */
export function fatalErrorFileStore(): FatalErrorStore {
  const { Directory, File, Paths } =
    require("expo-file-system") as typeof import("expo-file-system");
  const directory = new Directory(Paths.document, "diagnostics");
  const file = new File(directory, "fatal-errors.json");
  return {
    read: () => (file.exists ? file.textSync() : null),
    write: (text) => {
      directory.create({ intermediates: true, idempotent: true });
      file.write(text);
    },
    clear: () => {
      if (file.exists) file.delete();
    },
  };
}
