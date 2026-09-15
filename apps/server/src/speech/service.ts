// @effect-diagnostics nodeBuiltinImport:off - environment-owned transient audio and model lifecycle.
import { randomUUID } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SpeechError, type SpeechRequest, type SpeechResponse } from "@ryco/contracts";
import { VOICE_MAX_BYTES, VOICE_CHUNK_BYTES } from "@ryco/shared/voice";
import { ServerConfig } from "../config.ts";
import { installModel, modelPath, createModelReadiness } from "./model.ts";
import { helperAvailable, transcribeNative } from "./native.ts";

class VoiceFailure extends Error {}

type Job = {
  owner: string;
  id: string;
  abort: AbortController;
  bytes: Uint8Array[];
  length: number;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
  done?: Promise<unknown>;
};
export interface SpeechDependencies {
  supported(): boolean;
  ready(): Promise<boolean>;
  install(signal: AbortSignal): Promise<void>;
  remove(): Promise<void>;
  transcribe(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}
export function createSpeechService(deps: SpeechDependencies) {
  let job: Job | null = null;
  const retired = new Map<string, number>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  const retire = (owner: string, id: string) => {
    const now = Date.now();
    for (const [id, at] of retired) if (now - at > 300_000) retired.delete(id);
    retired.set(key(owner, id), now);
    while (retired.size > 256) retired.delete(retired.keys().next().value!);
  };
  const clear = (owned: Job) => {
    retire(owned.owner, owned.id);
    clearTimeout(owned.timer);
    owned.bytes.forEach((bytes) => bytes.fill(0));
    owned.bytes = [];
    if (job === owned) job = null;
  };
  const cancel = async (owned: Job) => {
    owned.abort.abort();
    if (owned.done) await owned.done.catch(() => {});
    clear(owned);
  };
  const reserve = (owner: string, id: string) => {
    if (retired.has(key(owner, id)))
      throw new VoiceFailure("Voice job was cancelled or already completed.");
    if (job) throw new VoiceFailure("This machine is already processing voice input.");
    const owned: Job = {
      owner,
      id,
      abort: new AbortController(),
      bytes: [],
      length: 0,
      sequence: 0,
      running: false,
      timer: setTimeout(() => {}, 0),
    };
    clearTimeout(owned.timer);
    owned.timer = setTimeout(() => {
      void cancel(owned);
    }, 150_000);
    job = owned;
    return owned;
  };
  const execute = async (
    owner: string,
    input: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SpeechResponse> => {
    if (input.action === "cancel") {
      retire(owner, input.requestId);
      if (job?.owner === owner && job.id === input.requestId) await cancel(job);
      return { state: "accepted" };
    }
    if (!deps.supported()) return { state: "unsupported" };
    if (input.action === "status")
      return { state: job ? "busy" : (await deps.ready()) ? "ready" : "missing-model" };
    if (input.action === "install" || input.action === "remove") {
      const owned = reserve(owner, input.action === "install" ? input.requestId : randomUUID());
      const abort = () => owned.abort.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        owned.done = input.action === "install" ? deps.install(owned.abort.signal) : deps.remove();
        await owned.done;
        return { state: input.action === "install" ? "ready" : "missing-model" };
      } finally {
        signal.removeEventListener("abort", abort);
        clear(owned);
      }
    }
    if (input.action === "begin") {
      const owned = reserve(owner, input.requestId);
      try {
        if (!(await deps.ready()))
          throw new VoiceFailure("Install the voice model explicitly before recording.");
        if (signal.aborted || owned.abort.signal.aborted)
          throw new VoiceFailure("Voice input cancelled.");
      } catch (error) {
        clear(owned);
        throw error;
      }
      return { state: "accepted" };
    }
    if (!("requestId" in input)) throw new VoiceFailure("Invalid voice operation.");
    const owned = job;
    if (
      !owned ||
      owned.owner !== owner ||
      owned.id !== input.requestId ||
      owned.running ||
      owned.abort.signal.aborted
    )
      throw new VoiceFailure("Voice job expired or is unavailable.");
    if (input.action === "chunk") {
      const bytes = Buffer.from(input.pcm, "base64");
      if (
        input.sequence !== owned.sequence ||
        !bytes.length ||
        bytes.length % 2 ||
        bytes.length > VOICE_CHUNK_BYTES ||
        owned.length + bytes.length > VOICE_MAX_BYTES ||
        bytes.toString("base64") !== input.pcm
      ) {
        bytes.fill(0);
        await cancel(owned);
        throw new VoiceFailure("Invalid or oversized voice recording.");
      }
      owned.bytes.push(bytes);
      owned.length += bytes.length;
      owned.sequence++;
      return { state: "accepted" };
    }
    owned.running = true;
    const abort = () => owned.abort.abort();
    signal.addEventListener("abort", abort, { once: true });
    const pcm = Buffer.concat(owned.bytes);
    try {
      if (!pcm.length) throw new VoiceFailure("Recording is empty.");
      if (signal.aborted) abort();
      if (pcm.every((byte) => byte === 0)) return { state: "transcribed", text: "" };
      owned.done = deps.transcribe(pcm, owned.abort.signal);
      const text = (await owned.done) as string;
      return { state: "transcribed", text };
    } finally {
      signal.removeEventListener("abort", abort);
      pcm.fill(0);
      clear(owned);
    }
  };
  return {
    request: (owner: string, input: SpeechRequest) =>
      Effect.tryPromise({
        try: (signal) => execute(owner, input, signal),
        catch: (cause) =>
          new SpeechError({
            message:
              cause instanceof VoiceFailure
                ? cause.message
                : "Voice operation failed. Check the optional helper, model installation, and available disk space.",
          }),
      }),
    closeOwner: (owner: string) => (job?.owner === owner ? cancel(job) : Promise.resolve()),
    close: () => (job ? cancel(job) : Promise.resolve()),
  };
}
export class SpeechService extends Context.Service<
  SpeechService,
  ReturnType<typeof createSpeechService>
>()("ryco/SpeechService") {}
export const SpeechServiceLive = Layer.effect(
  SpeechService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const directory = join(config.stateDir, "speech");
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await rm(join(directory, "model.part"), { force: true });
    });
    const service = createSpeechService({
      supported: helperAvailable,
      ready: createModelReadiness(directory),
      install: (signal) => installModel(directory, signal),
      remove: () => rm(modelPath(directory), { force: true }),
      transcribe: (bytes, signal) => transcribeNative(modelPath(directory), bytes, signal),
    });
    yield* Effect.addFinalizer(() => Effect.promise(service.close));
    return service;
  }),
);
