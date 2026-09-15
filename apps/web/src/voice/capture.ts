import { VOICE_MAX_BYTES, VOICE_SAMPLE_RATE, type VoiceCapture } from "@ryco/client-runtime/voice";

/** Each invocation owns its graph and permission result, including late permission grants. */
export function createBrowserVoiceCapture(): VoiceCapture {
  return {
    available:
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined",
    async start(signal, interrupted) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
        video: false,
      });
      if (signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Recording cancelled.");
      }
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      const chunks: Uint8Array[] = [];
      let length = 0;
      let stopped = false;
      let node: AudioWorkletNode | undefined;
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        stream.getTracks().forEach((track) => track.stop());
        node?.disconnect();
        void context.close().catch(() => {});
        signal.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        cleanup();
        chunks.forEach((chunk) => chunk.fill(0));
        chunks.length = 0;
      };
      signal.addEventListener("abort", cancel, { once: true });
      for (const track of stream.getAudioTracks())
        track.addEventListener(
          "ended",
          () => {
            if (!stopped) {
              cancel();
              interrupted?.(new Error("Microphone capture was interrupted."));
            }
          },
          { once: true },
        );
      try {
        if (context.sampleRate !== VOICE_SAMPLE_RATE)
          throw new Error("This browser cannot capture at the required sample rate.");
        await context.audioWorklet.addModule(new URL("./pcmWorklet.js", import.meta.url));
        if (signal.aborted) throw new Error("Recording cancelled.");
        node = new AudioWorkletNode(context, "ryco-pcm");
        node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (stopped) return;
          const bytes = new Uint8Array(event.data);
          const remaining = VOICE_MAX_BYTES - length;
          if (remaining > 0) {
            const bounded = bytes.slice(0, remaining);
            chunks.push(bounded);
            length += bounded.length;
          }
          if (length >= VOICE_MAX_BYTES) cleanup();
        };
        const source = context.createMediaStreamSource(stream);
        const mute = context.createGain();
        mute.gain.value = 0;
        source.connect(node);
        node.connect(mute);
        mute.connect(context.destination);
        await context.resume();
        if (signal.aborted) throw new Error("Recording cancelled.");
        return {
          cancel,
          async stop() {
            cleanup();
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
              chunk.fill(0);
            }
            chunks.length = 0;
            return bytes;
          },
        };
      } catch (error) {
        cancel();
        throw error;
      }
    },
  };
}
