import { useTaskCaptureGeneration, useTaskCaptureRequest } from "./taskCaptureStore";

/**
 * The app's one fast-capture sheet, opened through `openTaskCapture` from the
 * Tasks tab, a chat or a pull request. Mounted once at the app's root; the
 * sheet itself loads on first use, so it costs startup nothing.
 */
export function TaskCaptureHost() {
  const request = useTaskCaptureRequest();
  const generation = useTaskCaptureGeneration();
  if (request === null) return null;
  const { CaptureSession } =
    require("./TaskCaptureSession") as typeof import("./TaskCaptureSession");
  return <CaptureSession key={generation} request={request} />;
}
