import { vi } from "vite-plus/test";

/**
 * `vi.waitFor` sized for the browser suites. Its 1 s default is shorter than a cold Vite
 * transform, a lazy chunk or a Playwright round trip on a loaded CI runner, so a wait that
 * passes in 2–7 s there fails at the default while the app is still on its way.
 */
export function browserWaitFor<T>(
  callback: () => T | Promise<T>,
  options: { readonly timeout?: number; readonly interval?: number } = {},
): Promise<T> {
  return vi.waitFor(callback, { timeout: 8_000, interval: 16, ...options });
}
