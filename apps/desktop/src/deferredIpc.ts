import { lazyAsyncResource } from "./lazyAsyncResource.ts";

type InvokeListener = (event: unknown, ...args: readonly unknown[]) => unknown;

/** The subset of Electron's `ipcMain` used for invoke handlers. */
export interface IpcInvokeRegistrar {
  removeHandler(channel: string): void;
  handle(channel: string, listener: InvokeListener): void;
}

/**
 * Register invoke channels now and load the module that implements them on
 * first use. The renderer can call any channel at any time; the first call
 * waits for the module, later calls go straight to its handlers.
 *
 * `load` receives a registrar that captures the real handlers instead of
 * registering them with Electron, so the implementing module keeps its usual
 * `registerIpcHandlers(ipcMain)` shape.
 */
export function registerDeferredIpcHandlers(
  ipcMain: IpcInvokeRegistrar,
  channels: ReadonlyArray<string>,
  load: (registrar: IpcInvokeRegistrar) => Promise<void>,
): void {
  const handlers = new Map<string, InvokeListener>();
  const ready = lazyAsyncResource(() =>
    load({
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    }),
  );
  for (const channel of channels) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      await ready();
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler is registered for ${channel}.`);
      return await handler(event, ...args);
    });
  }
}
