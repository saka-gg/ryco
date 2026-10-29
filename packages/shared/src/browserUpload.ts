/**
 * `ryco_browser` upload rules both sides of the computer-use bridge apply: the server stages copies
 * of workspace files into `<desktop upload root>/<upload id>/<index>/<name>`, and the desktop
 * accepts only that layout before Chromium sees a path. One definition, so the two cannot drift.
 */

/** Files per upload (Synara's invocation limit, as for Computer Use uploads). */
export const BROWSER_UPLOAD_MAX_FILES = 32;
/** Characters per path, the model's workspace paths and the staged copies' paths alike. */
export const BROWSER_UPLOAD_MAX_PATH_LENGTH = 4096;

const UPLOAD_ID = /^u-[0-9a-f]{16}$/u;

/** A staged upload's directory name: `u-` and 16 lowercase hex digits. */
export const isBrowserUploadId = (value: unknown): value is string =>
  typeof value === "string" && UPLOAD_ID.test(value);

/** A fresh, unguessable upload directory name (64 random bits). */
export function newBrowserUploadId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `u-${hex}`;
}
