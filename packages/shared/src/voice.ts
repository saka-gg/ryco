export const VOICE_MAX_SECONDS = 60;
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_BYTES = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2;
export const VOICE_CHUNK_BYTES = 32_768;
export const VOICE_MODEL = {
  name: "Whisper Tiny Q8 (multilingual)",
  bytes: 45_981_088,
  sha256: "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
  url: "https://huggingface.co/handy-computer/whisper-tiny-gguf/resolve/6687f30c99641ee265df421e582354adbc8848fc/whisper-tiny-Q8_0.gguf",
  license: "Apache-2.0 conversion; MIT source Whisper model",
} as const;
