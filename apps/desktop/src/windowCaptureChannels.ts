/** IPC channels of composer window capture, shared by the preload bridge and main. */
export const WINDOW_CAPTURE_IPC = {
  getState: "desktop:window-capture:get-state",
  setup: "desktop:window-capture:setup",
  setShortcut: "desktop:window-capture:set-shortcut",
  listWindows: "desktop:window-capture:list-windows",
  captureWindow: "desktop:window-capture:capture-window",
  listPendingCaptures: "desktop:window-capture:list-pending",
  readPendingCapture: "desktop:window-capture:read-pending",
  acknowledgeCapture: "desktop:window-capture:acknowledge",
  state: "desktop:window-capture:state",
  captured: "desktop:window-capture:captured",
  error: "desktop:window-capture:error",
} as const;
