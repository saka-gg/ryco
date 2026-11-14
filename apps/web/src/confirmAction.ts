import { readLocalApi } from "./localApi";

/**
 * Asks the person to confirm `message`: the native dialog in the desktop app, the browser's
 * otherwise. Use this instead of `window.confirm`, which shows Chromium's dialog in the desktop
 * app.
 *
 * It rejects when the desktop dialog call fails. A handler that used to call the synchronous
 * `window.confirm` should treat that as "not confirmed": `confirmAction(m).catch(() => false)`.
 */
export function confirmAction(message: string): Promise<boolean> {
  const localApi = readLocalApi();
  return localApi ? localApi.dialogs.confirm(message) : Promise.resolve(window.confirm(message));
}
