/**
 * The Tabler icons the app renders on every platform.
 *
 * `@tabler/icons-react-native`'s package root is a CommonJS barrel that
 * requires all ~6,200 icon modules (Metro resolves its `require` condition,
 * so neither Expo tree shaking nor inline requires can drop the unused ones).
 * Every one of them used to be registered and evaluated before the first
 * frame for the handful this app renders. Each name below is a deep import of
 * one icon module instead; add new icons here rather than importing the
 * package root (a lint rule and `mobileStartupImports.test.ts` enforce that).
 * The Android-only SF Symbol fallbacks live in `AppSymbol.tsx`, which iOS never
 * loads.
 */
export { default as IconActivity } from "@tabler/icons-react-native/IconActivity";
export { default as IconAlertCircle } from "@tabler/icons-react-native/IconAlertCircle";
export { default as IconBrain } from "@tabler/icons-react-native/IconBrain";
export { default as IconBrandWindows } from "@tabler/icons-react-native/IconBrandWindows";
export { default as IconCircleDot } from "@tabler/icons-react-native/IconCircleDot";
export { default as IconClock } from "@tabler/icons-react-native/IconClock";
export { default as IconCloud } from "@tabler/icons-react-native/IconCloud";
export { default as IconCoin } from "@tabler/icons-react-native/IconCoin";
export { default as IconDatabase } from "@tabler/icons-react-native/IconDatabase";
export { default as IconDeviceDesktop } from "@tabler/icons-react-native/IconDeviceDesktop";
export { default as IconDeviceLaptop } from "@tabler/icons-react-native/IconDeviceLaptop";
export { default as IconFileDiff } from "@tabler/icons-react-native/IconFileDiff";
export { default as IconFolder } from "@tabler/icons-react-native/IconFolder";
export { default as IconGitBranch } from "@tabler/icons-react-native/IconGitBranch";
export { default as IconGitFork } from "@tabler/icons-react-native/IconGitFork";
export { default as IconGitMerge } from "@tabler/icons-react-native/IconGitMerge";
export { default as IconGitPullRequest } from "@tabler/icons-react-native/IconGitPullRequest";
export { default as IconMessage } from "@tabler/icons-react-native/IconMessage";
export { default as IconMessages } from "@tabler/icons-react-native/IconMessages";
export { default as IconServer } from "@tabler/icons-react-native/IconServer";
export { default as IconSparkles } from "@tabler/icons-react-native/IconSparkles";
export { default as IconStack2 } from "@tabler/icons-react-native/IconStack2";
export { default as IconTerminal2 } from "@tabler/icons-react-native/IconTerminal2";
export { default as IconTicket } from "@tabler/icons-react-native/IconTicket";
export { default as IconTool } from "@tabler/icons-react-native/IconTool";

export type { Icon } from "@tabler/icons-react-native";
