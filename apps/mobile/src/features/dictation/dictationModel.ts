// On-device dictation into a composer: where the spoken text lands in the
// draft, how the level meter reads the microphone, and what each failure tells
// the user. The speech itself never leaves the phone (useComposerDictation asks
// iOS for on-device recognition only).

export type DictationPhase = "idle" | "preparing" | "listening" | "finishing" | "error";

export interface DictationState {
  readonly phase: DictationPhase;
  readonly error: string | null;
  /** The error is fixed in Settings (a denied permission). */
  readonly errorAction: "settings" | null;
}

export const DICTATION_IDLE: DictationState = { phase: "idle", error: null, errorAction: null };

/** The draft and its caret or selection when dictation started; speech replaces the selection. */
export interface DictationAnchor {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Final segments so far plus the segment iOS is still revising. */
export interface DictationTranscript {
  readonly committed: string;
  readonly partial: string;
}

export const EMPTY_DICTATION_TRANSCRIPT: DictationTranscript = { committed: "", partial: "" };

/**
 * Folds one recognition result in. A final result closes its segment; later
 * segments arrive with their own leading space, as in the Web Speech API.
 */
export function applyDictationResult(
  transcript: DictationTranscript,
  result: { readonly text: string; readonly isFinal: boolean },
): DictationTranscript {
  if (!result.isFinal) return { committed: transcript.committed, partial: result.text };
  if (result.text.length === 0) return { committed: transcript.committed, partial: "" };
  return { committed: transcript.committed + result.text, partial: "" };
}

export function dictationTranscriptText(transcript: DictationTranscript): string {
  return `${transcript.committed}${transcript.partial}`.replace(/\s+/g, " ").trim();
}

/**
 * The draft with the spoken text in place of the anchor's selection, spaced
 * from the words around it, and the caret just after it.
 */
export function composeDictationDraft(
  anchor: DictationAnchor,
  spoken: string,
): { readonly text: string; readonly cursor: number } {
  const start = Math.max(0, Math.min(anchor.start, anchor.text.length));
  const end = Math.max(start, Math.min(anchor.end, anchor.text.length));
  const before = anchor.text.slice(0, start);
  const after = anchor.text.slice(end);
  if (spoken.length === 0) return { text: anchor.text, cursor: end };
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${spoken}${trail}`;
  return { text: `${before}${inserted}${after}`, cursor: before.length + inserted.length };
}

/** Bars the level meter draws, newest last. */
export const DICTATION_LEVEL_SAMPLES = 24;

/** iOS reports the input level from -2 (silence) to 10 (loud); the meter wants 0…1. */
export function normalizeDictationVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value + 2) / 12));
}

export function pushDictationLevel(
  levels: ReadonlyArray<number>,
  level: number,
): ReadonlyArray<number> {
  const next = [...levels, level];
  return next.length > DICTATION_LEVEL_SAMPLES ? next.slice(-DICTATION_LEVEL_SAMPLES) : next;
}

export function formatDictationElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The recognizer locale for the phone's language: the exact one, else the
 * first of the same language (`de` → `de-DE`), else none.
 */
export function resolveDictationLocale(
  preferred: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
): string | null {
  const normalize = (locale: string) => locale.replaceAll("_", "-").toLowerCase();
  const available = supported.map((locale) => ({ locale, key: normalize(locale) }));
  for (const candidate of preferred) {
    const key = normalize(candidate);
    const exact = available.find((entry) => entry.key === key);
    if (exact) return exact.locale;
    const language = key.split("-")[0];
    const sameLanguage = available.find((entry) => entry.key.split("-")[0] === language);
    if (sameLanguage) return sameLanguage.locale;
  }
  return null;
}

/**
 * What a recognizer error means for the user, or null when it only ends the
 * session (the user cancelled, or nothing was said).
 */
export function describeDictationError(
  code: string,
): { readonly message: string; readonly action: "settings" | null } | null {
  switch (code) {
    case "aborted":
    case "no-speech":
    case "speech-timeout":
      return null;
    case "not-allowed":
      return {
        message: "Allow the microphone and speech recognition for Ryco in Settings to dictate.",
        action: "settings",
      };
    case "audio-capture":
      return { message: "The microphone isn't available right now.", action: null };
    case "language-not-supported":
      return {
        message: "Dictation isn't available in your language on this device.",
        action: null,
      };
    case "service-not-allowed":
    case "network":
      return {
        message:
          "On-device dictation isn't available on this device. Ryco never sends your voice to a server.",
        action: null,
      };
    default:
      return { message: "Dictation stopped unexpectedly.", action: null };
  }
}
