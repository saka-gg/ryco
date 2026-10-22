import { parentPort, workerData } from "node:worker_threads";

import type { ReactCompilerJob, ReactCompilerWorkerData } from "./reactCompilerPool";
import { createReactCompilerTransform } from "./reactCompilerTransform.ts";

// Loaded by Node directly (type stripping), not through Vite: keep this module
// to erasable syntax, type-only imports of Vite-only modules and explicit `.ts`
// extensions on runtime imports.

const transform = createReactCompilerTransform(workerData as ReactCompilerWorkerData);

const port = parentPort;
if (!port) throw new Error("reactCompilerWorker must run as a worker thread");
port.on("message", (job: ReactCompilerJob) => {
  void transform(job).then((result) => port.postMessage(result));
});
