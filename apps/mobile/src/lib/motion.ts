import { Easing, ReduceMotion } from "react-native-reanimated";

/** Shared quick-settling motion, with all interpolation running on the UI thread. */
export const appMotion = {
  spring: {
    damping: 30,
    stiffness: 440,
    mass: 0.8,
    overshootClamping: true,
    reduceMotion: ReduceMotion.System,
  },
  enter: {
    duration: 220,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    reduceMotion: ReduceMotion.System,
  },
  exit: { duration: 100, easing: Easing.bezier(0.4, 0, 1, 1), reduceMotion: ReduceMotion.System },
  levelOut: {
    duration: 40,
    easing: Easing.bezier(0.4, 0, 1, 1),
    reduceMotion: ReduceMotion.System,
  },
  resize: {
    duration: 300,
    easing: Easing.bezier(0.22, 0.85, 0.25, 1),
    reduceMotion: ReduceMotion.System,
  },
  levelIn: {
    duration: 240,
    easing: Easing.bezier(0.22, 0.85, 0.25, 1),
    reduceMotion: ReduceMotion.System,
  },
} as const;
