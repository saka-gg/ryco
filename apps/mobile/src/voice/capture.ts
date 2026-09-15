import native from "@ryco/mobile-voice";
import { Schema } from "effect";
const decodeBase64 = Schema.decodeUnknownSync(Schema.Uint8ArrayFromBase64);
import type { VoiceCapture } from "@ryco/client-runtime/voice";

export function createNativeVoiceCapture(id: () => string): VoiceCapture {
  return {
    available: native !== null,
    async start(signal, interrupted) {
      if (!native)
        throw new Error("Voice capture requires an iOS app build with microphone support.");
      const module = native;
      const key = id();
      if (!(await module.permission())) throw new Error("Microphone permission was denied.");
      signal.throwIfAborted();
      const subscription = module.addListener("interrupted", (event) => {
        if (event.id === key) interrupted?.(new Error("Microphone capture was interrupted."));
      });
      const cancel = () => {
        subscription.remove();
        void module.cancel(key).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await module.start(key);
        if (signal.aborted) {
          await module.cancel(key);
          signal.throwIfAborted();
        }
        return {
          async stop() {
            try {
              return decodeBase64(await module.stop(key));
            } finally {
              subscription.remove();
              signal.removeEventListener("abort", cancel);
            }
          },
          cancel() {
            subscription.remove();
            signal.removeEventListener("abort", cancel);
            cancel();
          },
        };
      } catch (error) {
        subscription.remove();
        signal.removeEventListener("abort", cancel);
        await module.cancel(key).catch(() => {});
        throw error;
      }
    },
  };
}
