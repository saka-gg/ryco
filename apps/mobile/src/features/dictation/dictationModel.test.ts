import { describe, expect, it } from "vite-plus/test";

import {
  applyDictationResult,
  composeDictationDraft,
  describeDictationError,
  DICTATION_LEVEL_SAMPLES,
  dictationTranscriptText,
  EMPTY_DICTATION_TRANSCRIPT,
  formatDictationElapsed,
  normalizeDictationVolume,
  pushDictationLevel,
  resolveDictationLocale,
} from "./dictationModel";

describe("applyDictationResult", () => {
  it("revises the open segment and appends final ones", () => {
    let transcript = EMPTY_DICTATION_TRANSCRIPT;
    transcript = applyDictationResult(transcript, { text: "fix the", isFinal: false });
    transcript = applyDictationResult(transcript, { text: "fix the login", isFinal: false });
    expect(dictationTranscriptText(transcript)).toBe("fix the login");
    transcript = applyDictationResult(transcript, { text: "Fix the login.", isFinal: true });
    transcript = applyDictationResult(transcript, { text: " Then run", isFinal: false });
    expect(dictationTranscriptText(transcript)).toBe("Fix the login. Then run");
    transcript = applyDictationResult(transcript, { text: "", isFinal: true });
    expect(dictationTranscriptText(transcript)).toBe("Fix the login.");
  });
});

describe("composeDictationDraft", () => {
  it("inserts at the caret with spaces around the spoken words", () => {
    expect(composeDictationDraft({ text: "Please now", start: 6, end: 6 }, "fix it")).toEqual({
      text: "Please fix it now",
      cursor: 13,
    });
    expect(composeDictationDraft({ text: "", start: 0, end: 0 }, "hello")).toEqual({
      text: "hello",
      cursor: 5,
    });
  });

  it("replaces a selection and leaves the draft alone when nothing was said", () => {
    expect(composeDictationDraft({ text: "a XX b", start: 2, end: 4 }, "word").text).toBe(
      "a word b",
    );
    expect(composeDictationDraft({ text: "keep", start: 4, end: 4 }, "")).toEqual({
      text: "keep",
      cursor: 4,
    });
  });
});

describe("level meter", () => {
  it("maps the iOS level range and keeps the newest samples", () => {
    expect(normalizeDictationVolume(-2)).toBe(0);
    expect(normalizeDictationVolume(10)).toBe(1);
    expect(normalizeDictationVolume(4)).toBeCloseTo(0.5);
    expect(normalizeDictationVolume(Number.NaN)).toBe(0);
    let levels: ReadonlyArray<number> = [];
    for (let index = 0; index < DICTATION_LEVEL_SAMPLES + 3; index += 1) {
      levels = pushDictationLevel(levels, index);
    }
    expect(levels).toHaveLength(DICTATION_LEVEL_SAMPLES);
    expect(levels.at(-1)).toBe(DICTATION_LEVEL_SAMPLES + 2);
  });

  it("formats the elapsed time", () => {
    expect(formatDictationElapsed(65.7)).toBe("1:05");
  });
});

describe("resolveDictationLocale", () => {
  it("prefers the exact locale, then the same language", () => {
    const supported = ["en-US", "en-GB", "de-DE", "fr-FR"];
    expect(resolveDictationLocale(["en_GB"], supported)).toBe("en-GB");
    expect(resolveDictationLocale(["de-AT"], supported)).toBe("de-DE");
    expect(resolveDictationLocale(["xx-YY", "fr"], supported)).toBe("fr-FR");
    expect(resolveDictationLocale(["xx"], supported)).toBeNull();
  });
});

describe("describeDictationError", () => {
  it("stays quiet for a cancel or silence and points denied permissions to Settings", () => {
    expect(describeDictationError("aborted")).toBeNull();
    expect(describeDictationError("no-speech")).toBeNull();
    expect(describeDictationError("not-allowed")?.action).toBe("settings");
    expect(describeDictationError("network")?.message).toContain("never sends your voice");
  });
});
