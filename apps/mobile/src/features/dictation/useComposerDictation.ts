import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../native/ComposerEditor";
import {
  applyDictationResult,
  composeDictationDraft,
  describeDictationError,
  DICTATION_IDLE,
  dictationTranscriptText,
  EMPTY_DICTATION_TRANSCRIPT,
  normalizeDictationVolume,
  pushDictationLevel,
  resolveDictationLocale,
  type DictationAnchor,
  type DictationState,
} from "./dictationModel";

export interface ComposerDictation {
  readonly state: DictationState;
  /** A session is starting, listening or finishing: the draft follows the speech. */
  readonly active: boolean;
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly elapsedSeconds: number;
  readonly start: () => void;
  /** Ends listening and keeps what was said. */
  readonly finish: () => void;
  /** Ends listening and puts the draft back as it was. */
  readonly cancel: () => void;
  readonly dismissError: () => void;
  readonly openSettings: () => void;
}

function preferredLocales(): string[] {
  const locales: string[] = [];
  try {
    locales.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // Fall through to English below.
  }
  locales.push("en-US");
  return locales;
}

/**
 * Dictation into one composer with iOS speech recognition that runs on the
 * phone only: the request requires on-device recognition, and a device or
 * language without an on-device model fails instead of using Apple's servers
 * (patched into expo-speech-recognition). Partial results stream into the
 * draft at the caret; cancelling restores the draft.
 *
 * Speech events are app-wide, so a composer reacts to them only while it owns
 * the session it started.
 */
export function useComposerDictation(input: {
  readonly text: string;
  readonly selection: ComposerEditorSelection;
  readonly onChangeText: (text: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}): ComposerDictation {
  const [state, setState] = useState<DictationState>(DICTATION_IDLE);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const levels = useSharedValue<ReadonlyArray<number>>([]);
  const ownsSession = useRef(false);
  // Bumped by cancel: a start still asking for permission must not begin listening.
  const generation = useRef(0);
  const anchor = useRef<DictationAnchor>({ text: "", start: 0, end: 0 });
  const transcript = useRef(EMPTY_DICTATION_TRANSCRIPT);
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsedSeconds((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(
    () => () => {
      if (ownsSession.current) ExpoSpeechRecognitionModule.abort();
      ownsSession.current = false;
    },
    [],
  );

  const fail = (code: string) => {
    const described = describeDictationError(code);
    setState(
      described
        ? { phase: "error", error: described.message, errorAction: described.action }
        : DICTATION_IDLE,
    );
  };

  const reset = () => {
    ownsSession.current = false;
    setStartedAt(null);
    setElapsedSeconds(0);
    levels.set([]);
  };

  useSpeechRecognitionEvent("start", () => {
    if (!ownsSession.current) return;
    setState({ phase: "listening", error: null, errorAction: null });
    setStartedAt(Date.now());
  });

  useSpeechRecognitionEvent("result", (event) => {
    if (!ownsSession.current) return;
    transcript.current = applyDictationResult(transcript.current, {
      text: event.results[0]?.transcript ?? "",
      isFinal: event.isFinal,
    });
    const draft = composeDictationDraft(
      anchor.current,
      dictationTranscriptText(transcript.current),
    );
    latest.current.onChangeText(draft.text);
    latest.current.onChangeSelection({ start: draft.cursor, end: draft.cursor });
  });

  useSpeechRecognitionEvent("volumechange", (event) => {
    if (!ownsSession.current) return;
    levels.set(pushDictationLevel(levels.get(), normalizeDictationVolume(event.value)));
  });

  useSpeechRecognitionEvent("error", (event) => {
    if (!ownsSession.current) return;
    fail(event.error);
  });

  useSpeechRecognitionEvent("end", () => {
    if (!ownsSession.current) return;
    reset();
    setState((current) => (current.phase === "error" ? current : DICTATION_IDLE));
  });

  const start = () => {
    if (state.phase === "preparing" || state.phase === "listening" || state.phase === "finishing") {
      return;
    }
    setState({ phase: "preparing", error: null, errorAction: null });
    const startedGeneration = generation.current;
    const failCurrent = (code: string) => {
      if (generation.current === startedGeneration) fail(code);
    };
    void (async () => {
      try {
        if (!ExpoSpeechRecognitionModule.isRecognitionAvailable())
          return failCurrent("service-not-allowed");
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) return failCurrent("not-allowed");
        if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
          return failCurrent("service-not-allowed");
        }
        const { locales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
        const lang = resolveDictationLocale(preferredLocales(), locales);
        if (!lang) return failCurrent("language-not-supported");
        if (generation.current !== startedGeneration) return;
        const { text, selection } = latest.current;
        anchor.current = { text, start: selection.start, end: selection.end };
        transcript.current = EMPTY_DICTATION_TRANSCRIPT;
        ownsSession.current = true;
        ExpoSpeechRecognitionModule.start({
          lang,
          interimResults: true,
          continuous: true,
          requiresOnDeviceRecognition: true,
          addsPunctuation: true,
          iosTaskHint: "dictation",
          volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
        });
      } catch {
        ownsSession.current = false;
        failCurrent("unknown");
      }
    })();
  };

  const finish = () => {
    if (!ownsSession.current) return;
    setState({ phase: "finishing", error: null, errorAction: null });
    ExpoSpeechRecognitionModule.stop();
  };

  const cancel = () => {
    generation.current += 1;
    if (ownsSession.current) {
      reset();
      ExpoSpeechRecognitionModule.abort();
      const { text, start: from, end: to } = anchor.current;
      latest.current.onChangeText(text);
      latest.current.onChangeSelection({ start: from, end: to });
    }
    setState(DICTATION_IDLE);
  };

  return {
    state,
    active:
      state.phase === "preparing" || state.phase === "listening" || state.phase === "finishing",
    levels,
    elapsedSeconds,
    start,
    finish,
    cancel,
    dismissError: () => setState(DICTATION_IDLE),
    openSettings: () => {
      setState(DICTATION_IDLE);
      void Linking.openSettings();
    },
  };
}
