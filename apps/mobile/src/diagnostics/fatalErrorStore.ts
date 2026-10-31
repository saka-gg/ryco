import type { FatalErrorStore } from "./fatalErrorRecorder";

/**
 * The records' file, `<caches>/diagnostics/fatal-errors.json`. `expo-file-system` loads
 * through a function-scoped require, at the first crash or when Diagnostics opens, never at
 * launch. The cache directory stays out of device backups; the system may empty it when the
 * device runs out of space, which only loses crash records.
 */
export function fatalErrorFileStore(): FatalErrorStore {
  const { Directory, File, Paths } =
    require("expo-file-system") as typeof import("expo-file-system");
  const directory = new Directory(Paths.cache, "diagnostics");
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
