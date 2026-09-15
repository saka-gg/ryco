// @effect-diagnostics nodeBuiltinImport:off - native compute is isolated in a killable child process.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

function helperModuleUrl(): string {
  const url = import.meta.resolve("transcribe-cpp");
  // FFI loads physical libraries; Electron archives cannot supply dlopen paths.
  return process.versions.electron ? url.replace("/app.asar/", "/app.asar.unpacked/") : url;
}

/** Only this optional package runs native code, lazily and outside the server process. */
export function helperAvailable(): boolean {
  if (
    !["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"].includes(
      `${process.platform}-${process.arch}`,
    )
  )
    return false;
  try {
    const module = helperModuleUrl();
    const packages: Record<string, string> = {
      "darwin-arm64": "darwin-arm64-metal",
      "darwin-x64": "darwin-x64-cpu",
      "linux-x64": "linux-x64-cpu-vulkan",
      "linux-arm64": "linux-arm64-cpu-vulkan",
      "win32-x64": "win32-x64-cpu-vulkan",
    };
    createRequire(module).resolve(
      `@transcribe-cpp/${packages[`${process.platform}-${process.arch}`]}/package.json`,
    );
    return true;
  } catch {
    return false;
  }
}
const entry = `
process.once("message", async ({ moduleUrl, path, bytes }) => {
  try {
    const { TranscribeModel } = await import(moduleUrl);
    const model = await TranscribeModel.load(path, { backend: "cpu" });
    const raw = Uint8Array.from(bytes);
    const view = new DataView(raw.buffer);
    const pcm = new Float32Array(raw.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
    const session = model.createSession({ nThreads: 2 });
    const result = await session.run(pcm, { timestamps: "none" });
    session.dispose();
    model.dispose();
    process.send({ text: result.text });
  } catch { process.send({ error: true }); }
});
process.on("disconnect", () => process.exit(0));
`;
export function transcribeNative(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(process.execPath, ["--input-type=module", "-e", entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: process.env.TMPDIR,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    let text: string | undefined;
    let error: Error | undefined;
    const stop = () => {
      error = new Error("Voice inference cancelled.");
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      error = new Error("Voice inference timed out.");
      child.kill("SIGKILL");
    }, 120_000);
    signal.addEventListener("abort", stop, { once: true });
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "text" in message &&
        typeof message.text === "string" &&
        message.text.length <= 32_000
      )
        text = message.text.trim();
      else error = new Error("The optional speech helper could not transcribe this recording.");
      child.kill("SIGKILL");
    });
    child.on("error", () => {
      error = new Error("The optional speech helper could not start.");
    });
    child.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (error || text === undefined)
        reject(error ?? new Error("The speech helper exited unexpectedly."));
      else resolve(text);
    });
    if (signal.aborted) stop();
    else
      child.send({ moduleUrl: helperModuleUrl(), path, bytes }, (cause) => {
        if (cause) {
          error = new Error("Could not send audio to the speech helper.");
          child.kill("SIGKILL");
        }
      });
  });
}
