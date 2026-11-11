import { Easing } from "react-native-reanimated";

// The machine page's motion in the Machines sheet, from the approved mockup (layout C).

/** `.detail`: `transform .32s cubic-bezier(.2,.8,.2,1)`, both ways. */
export const MACHINE_PAGE_SLIDE = { duration: 320, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
/** `.nav .ttl`: `opacity .2s` (CSS `ease`) once the page scrolled past the header. */
export const MACHINE_PAGE_TITLE_FADE = { duration: 200, easing: Easing.bezier(0.25, 0.1, 0.25, 1) };
