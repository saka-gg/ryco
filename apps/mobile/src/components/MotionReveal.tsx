import type { ReactNode } from "react";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { appMotion } from "../lib/motion";

const reveal = FadeIn.duration(appMotion.enter.duration)
  .easing(appMotion.enter.easing)
  .reduceMotion(ReduceMotion.System);
/** A short compositor-only reveal; no layout animation or delayed touch targets. */
export function MotionReveal({ children }: { children: ReactNode }) {
  return <Animated.View entering={reveal}>{children}</Animated.View>;
}
