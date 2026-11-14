import { rename } from "node:fs/promises";

const MAX_ATTEMPTS = 5;

/** Whether `error` is the transient EPERM/EBUSY Windows reports while a scanner holds a file. */
const isTransientWindowsRenameError = (error: unknown, platform: NodeJS.Platform): boolean => {
  if (platform !== "win32") return false;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "EPERM" || code === "EBUSY";
};

/**
 * Renames, retrying the transient EPERM/EBUSY Windows reports while a scanner holds a file:
 * five attempts, 100, 200, 400 and 800 ms apart. Any other error, or one on another platform,
 * is thrown at once.
 */
export const renameWithRetry = async (
  from: string,
  to: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly rename?: (from: string, to: string) => Promise<void>;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const renameFile = options.rename ?? rename;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS - 1 || !isTransientWindowsRenameError(error, platform)) {
        throw error;
      }
      await sleep(100 * 2 ** attempt);
    }
  }
};
