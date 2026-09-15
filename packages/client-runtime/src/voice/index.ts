import type { SpeechRequest, SpeechResponse } from "@ryco/contracts";

import { VOICE_MAX_SECONDS, VOICE_MAX_BYTES, VOICE_CHUNK_BYTES } from "@ryco/shared/voice";
export * from "@ryco/shared/voice";

/** Platforms own permission prompts and PCM16 LE capture; no audio is persisted. */
export interface VoiceCapture {
  readonly available: boolean;
  start(signal: AbortSignal, interrupted?: (error: Error) => void): Promise<VoiceRecording>;
}
export interface VoiceRecording {
  stop(): Promise<Uint8Array>;
  cancel(): void;
}
export interface VoiceApi {
  request(input: SpeechRequest): Promise<SpeechResponse>;
}
export type VoiceState = {
  phase:
    | "idle"
    | "checking"
    | "missing-model"
    | "unsupported"
    | "recording"
    | "transcribing"
    | "review"
    | "installing"
    | "error";
  text: string;
  error: string | null;
};
export interface VoiceControllerOptions {
  capture: VoiceCapture;
  api: VoiceApi;
  /** Captures and validates existing environment/lifecycle authority, never creates it. */
  authorize(): { isCurrent(): boolean; canCancel(): boolean } | null;
  encode(bytes: Uint8Array): string;
  id(): string;
  insert(text: string): void;
}

export function createVoiceController(options: VoiceControllerOptions) {
  let state: VoiceState = { phase: "idle", text: "", error: null };
  const listeners = new Set<() => void>();
  type Run = {
    id: string;
    abort: AbortController;
    valid: () => boolean;
    canCancel: () => boolean;
    recording?: VoiceRecording;
  };
  let current: Run | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: VoiceState) => {
    state = next;
    listeners.forEach((fn) => fn());
  };
  const cancel = (send = true) => {
    const old = current;
    current = null;
    if (timer !== undefined) clearTimeout(timer);
    old?.abort.abort();
    old?.recording?.cancel();
    if (old && send && old.canCancel())
      void options.api.request({ action: "cancel", requestId: old.id }).catch(() => {});
    publish({ phase: "idle", text: "", error: null });
  };
  const begin = () => {
    cancel();
    const authority = options.authorize();
    if (!authority || !authority.isCurrent()) {
      publish({ phase: "error", text: "", error: "This machine is not ready for voice input." });
      return null;
    }
    const run: NonNullable<typeof current> = {
      id: options.id(),
      abort: new AbortController(),
      valid: authority.isCurrent,
      canCancel: authority.canCancel,
    };
    current = run;
    return run;
  };
  const fresh = (run: Run) => current === run && !run.abort.signal.aborted && run.valid();
  const fail = (run: Run, error: unknown) => {
    if (current !== run) return;
    cancel();
    publish({
      phase: "error",
      text: "",
      error: error instanceof Error ? error.message : "Voice input failed.",
    });
  };
  const call = async (run: Run, input: SpeechRequest) => {
    if (!fresh(run))
      throw new Error("Voice input was interrupted. Record again after reconnecting.");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Voice input cancelled."));
      run.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    let result: SpeechResponse;
    try {
      result = await Promise.race([options.api.request(input), aborted]);
    } finally {
      if (onAbort) run.abort.signal.removeEventListener("abort", onAbort);
    }
    if (!fresh(run))
      throw new Error("Voice input was interrupted. Record again after reconnecting.");
    return result;
  };
  const stop = async () => {
    const run = current;
    if (!run || state.phase !== "recording") return;
    if (timer !== undefined) clearTimeout(timer);
    publish({ phase: "transcribing", text: "", error: null });
    let bytes: Uint8Array | undefined;
    try {
      bytes = await run.recording!.stop();
      if (bytes.length === 0 || bytes.length > VOICE_MAX_BYTES || bytes.length % 2)
        throw new Error("Recording is empty or exceeds 60 seconds.");
      const admitted = await call(run, { action: "begin", requestId: run.id });
      if (admitted.state !== "accepted")
        throw new Error("Voice inference is unavailable on this machine.");
      for (
        let offset = 0, sequence = 0;
        offset < bytes.length;
        offset += VOICE_CHUNK_BYTES, sequence++
      ) {
        await call(run, {
          action: "chunk",
          requestId: run.id,
          sequence,
          pcm: options.encode(bytes.subarray(offset, offset + VOICE_CHUNK_BYTES)),
        });
      }
      bytes.fill(0);
      const result = await call(run, { action: "finish", requestId: run.id });
      if (result.state !== "transcribed")
        throw new Error("Voice inference did not return a transcript.");
      publish({ phase: "review", text: result.text ?? "", error: null });
    } catch (error) {
      fail(run, error);
    } finally {
      bytes?.fill(0);
      run.recording?.cancel();
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    cancel,
    revalidate() {
      if (current && !fresh(current)) cancel();
    },
    async start() {
      const run = begin();
      if (!run) return;
      if (!options.capture.available) {
        publish({
          phase: "unsupported",
          text: "",
          error: "Microphone capture is unavailable in this app build.",
        });
        return;
      }
      publish({ phase: "checking", text: "", error: null });
      try {
        const status = await call(run, { action: "status" });
        if (status.state !== "ready") {
          publish({
            phase:
              status.state === "missing-model"
                ? "missing-model"
                : status.state === "unsupported"
                  ? "unsupported"
                  : "error",
            text: "",
            error:
              status.state === "busy" ? "This machine is already processing voice input." : null,
          });
          return;
        }
        const recording = await options.capture.start(run.abort.signal, (error) =>
          fail(run, error),
        );
        if (!fresh(run)) {
          recording.cancel();
          return;
        }
        run.recording = recording;
        publish({ phase: "recording", text: "", error: null });
        timer = setTimeout(() => {
          void stop();
        }, VOICE_MAX_SECONDS * 1000);
      } catch (error) {
        fail(run, error);
      }
    },
    stop,
    async install() {
      const run = begin();
      if (!run) return;
      publish({ phase: "installing", text: "", error: null });
      try {
        const result = await call(run, { action: "install", requestId: run.id });
        if (result.state !== "ready") throw new Error("The optional speech helper is unavailable.");
        cancel(false);
      } catch (error) {
        fail(run, error);
      }
    },
    async remove() {
      const run = begin();
      if (!run) return;
      try {
        await call(run, { action: "remove" });
        cancel(false);
      } catch (error) {
        fail(run, error);
      }
    },
    edit(text: string) {
      if (state.phase === "review") publish({ ...state, text });
    },
    insert() {
      if (state.phase !== "review" || !current || !fresh(current)) {
        cancel(false);
        return;
      }
      const text = state.text.trim();
      if (text) options.insert(text);
      cancel(false);
    },
  };
}
