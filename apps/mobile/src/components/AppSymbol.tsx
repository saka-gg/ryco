// Android (and any non-iOS) implementation. iOS resolves `AppSymbol.ios.tsx`,
// which renders SF Symbols directly, so none of the Tabler fallback modules
// below are part of the iOS bundle. Each icon is a deep import of one module:
// the package root would evaluate the whole ~6,200-icon set (see ./icons.ts).
import IconAdjustmentsHorizontal from "@tabler/icons-react-native/IconAdjustmentsHorizontal";
import IconAlertCircle from "@tabler/icons-react-native/IconAlertCircle";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import IconAppWindow from "@tabler/icons-react-native/IconAppWindow";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconArrowBackUp from "@tabler/icons-react-native/IconArrowBackUp";
import IconArrowDownCircle from "@tabler/icons-react-native/IconArrowDownCircle";
import IconArrowRightCircle from "@tabler/icons-react-native/IconArrowRightCircle";
import IconArrowUp from "@tabler/icons-react-native/IconArrowUp";
import IconArrowUpCircle from "@tabler/icons-react-native/IconArrowUpCircle";
import IconArrowUpRight from "@tabler/icons-react-native/IconArrowUpRight";
import IconArrowUpRightCircle from "@tabler/icons-react-native/IconArrowUpRightCircle";
import IconArrowsMaximize from "@tabler/icons-react-native/IconArrowsMaximize";
import IconBellRinging from "@tabler/icons-react-native/IconBellRinging";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconCamera from "@tabler/icons-react-native/IconCamera";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconChevronDown from "@tabler/icons-react-native/IconChevronDown";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconChevronLeft from "@tabler/icons-react-native/IconChevronLeft";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import IconChevronUp from "@tabler/icons-react-native/IconChevronUp";
import IconCircleCheck from "@tabler/icons-react-native/IconCircleCheck";
import IconCircleXFilled from "@tabler/icons-react-native/IconCircleXFilled";
import IconClipboardList from "@tabler/icons-react-native/IconClipboardList";
import IconCopy from "@tabler/icons-react-native/IconCopy";
import IconDeviceDesktop from "@tabler/icons-react-native/IconDeviceDesktop";
import IconDots from "@tabler/icons-react-native/IconDots";
import IconDotsCircleHorizontal from "@tabler/icons-react-native/IconDotsCircleHorizontal";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import IconExternalLink from "@tabler/icons-react-native/IconExternalLink";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconFileText from "@tabler/icons-react-native/IconFileText";
import IconFilter from "@tabler/icons-react-native/IconFilter";
import IconFolder from "@tabler/icons-react-native/IconFolder";
import IconFolderOpen from "@tabler/icons-react-native/IconFolderOpen";
import IconFolderPlus from "@tabler/icons-react-native/IconFolderPlus";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconHammer from "@tabler/icons-react-native/IconHammer";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconHelpCircle from "@tabler/icons-react-native/IconHelpCircle";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import IconKeyboard from "@tabler/icons-react-native/IconKeyboard";
import IconKeyboardHide from "@tabler/icons-react-native/IconKeyboardHide";
import IconLayoutColumns from "@tabler/icons-react-native/IconLayoutColumns";
import IconLayoutSidebar from "@tabler/icons-react-native/IconLayoutSidebar";
import IconLetterSpacing from "@tabler/icons-react-native/IconLetterSpacing";
import IconLink from "@tabler/icons-react-native/IconLink";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconLockOpen from "@tabler/icons-react-native/IconLockOpen";
import IconMessage from "@tabler/icons-react-native/IconMessage";
import IconMinus from "@tabler/icons-react-native/IconMinus";
import IconNetwork from "@tabler/icons-react-native/IconNetwork";
import IconPalette from "@tabler/icons-react-native/IconPalette";
import IconPlayerPlay from "@tabler/icons-react-native/IconPlayerPlay";
import IconPlayerStopFilled from "@tabler/icons-react-native/IconPlayerStopFilled";
import IconPlus from "@tabler/icons-react-native/IconPlus";
import IconQrcode from "@tabler/icons-react-native/IconQrcode";
import IconRefresh from "@tabler/icons-react-native/IconRefresh";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconShare from "@tabler/icons-react-native/IconShare";
import IconShieldCheck from "@tabler/icons-react-native/IconShieldCheck";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconLayoutSidebarRight from "@tabler/icons-react-native/IconLayoutSidebarRight";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTextDecrease from "@tabler/icons-react-native/IconTextDecrease";
import IconTextIncrease from "@tabler/icons-react-native/IconTextIncrease";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconTypography from "@tabler/icons-react-native/IconTypography";
import IconUserCircle from "@tabler/icons-react-native/IconUserCircle";
import IconWifiOff from "@tabler/icons-react-native/IconWifiOff";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import IconX from "@tabler/icons-react-native/IconX";
import type { Icon } from "./icons";
import { Platform } from "react-native";
import { SymbolView as ExpoSymbolView, type SFSymbol, type SymbolViewProps } from "expo-symbols";

const ANDROID_ICON_BY_SF_SYMBOL: Partial<Record<SFSymbol, Icon>> = {
  "arrow.branch": IconGitBranch,
  "arrow.clockwise": IconRefresh,
  "arrow.down.circle": IconArrowDownCircle,
  "arrow.right.circle": IconArrowRightCircle,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.triangle.pull": IconGitPullRequest,
  "arrow.turn.left.up": IconArrowBackUp,
  "arrow.up": IconArrowUp,
  "arrow.up.circle": IconArrowUpCircle,
  "arrow.up.left.and.arrow.down.right": IconArrowsMaximize,
  "arrow.up.right": IconArrowUpRight,
  "arrow.up.right.circle": IconArrowUpRightCircle,
  "arrow.uturn.backward": IconArrowBackUp,
  archivebox: IconArchive,
  "archivebox.fill": IconArchive,
  "bell.badge": IconBellRinging,
  "bolt.circle": IconBolt,
  "bolt.horizontal.circle": IconBolt,
  camera: IconCamera,
  checkmark: IconCheck,
  "checkmark.circle": IconCircleCheck,
  "checkmark.shield": IconShieldCheck,
  "chevron.down": IconChevronDown,
  "chevron.left": IconChevronLeft,
  "chevron.left.forwardslash.chevron.right": IconCode,
  "chevron.right": IconChevronRight,
  "chevron.up": IconChevronUp,
  desktopcomputer: IconDeviceDesktop,
  "doc.on.doc": IconCopy,
  "doc.text": IconFileText,
  ellipsis: IconDots,
  "ellipsis.circle": IconDotsCircleHorizontal,
  "exclamationmark.triangle": IconAlertTriangle,
  eye: IconEye,
  folder: IconFolder,
  "folder.badge.plus": IconFolderPlus,
  "folder.fill": IconFolder,
  gearshape: IconSettings,
  hammer: IconHammer,
  "info.circle": IconInfoCircle,
  link: IconLink,
  "line.3.horizontal.decrease": IconFilter,
  "line.3.horizontal.decrease.circle": IconFilter,
  "line.3.horizontal.decrease.circle.fill": IconFilter,
  "list.clipboard": IconClipboardList,
  lock: IconLock,
  "lock.open": IconLockOpen,
  macwindow: IconAppWindow,
  magnifyingglass: IconSearch,
  paintbrush: IconPalette,
  "person.crop.circle": IconUserCircle,
  play: IconPlayerPlay,
  plus: IconPlus,
  "questionmark.circle": IconHelpCircle,
  "qrcode.viewfinder": IconQrcode,
  "point.3.connected.trianglepath.dotted": IconNetwork,
  "point.topleft.down.curvedto.point.bottomright.up": IconGitMerge,
  safari: IconExternalLink,
  "server.rack": IconServer,
  "sidebar.left": IconLayoutSidebar,
  "sidebar.right": IconLayoutSidebarRight,
  "slider.horizontal.3": IconAdjustmentsHorizontal,
  "square.and.arrow.up": IconShare,
  "square.and.pencil": IconEdit,
  "square.split.2x1": IconLayoutColumns,
  "stop.fill": IconPlayerStopFilled,
  terminal: IconTerminal2,
  "text.bubble": IconMessage,
  "text.word.spacing": IconLetterSpacing,
  "textformat.size": IconTypography,
  "textformat.size.larger": IconTextIncrease,
  "textformat.size.smaller": IconTextDecrease,
  trash: IconTrash,
  "wifi.slash": IconWifiOff,
  xmark: IconX,
  "xmark.circle.fill": IconCircleXFilled,
};

// Callers can pass `{ ios, android }` names where `android` is a Material
// icon name (the raw expo-symbols contract). Resolve those here too so the
// android key keeps working through this wrapper — it wins over the SF map
// when both match (e.g. folder vs folder_open for expanded project groups).
const ANDROID_ICON_BY_MATERIAL_NAME: Record<string, Icon> = {
  auto_awesome: IconSparkles,
  bolt: IconBolt,
  build: IconTool,
  chat_bubble: IconMessage,
  check: IconCheck,
  close: IconX,
  construction: IconHammer,
  content_copy: IconCopy,
  edit: IconEdit,
  error: IconAlertCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  keyboard_arrow_up: IconChevronUp,
  keyboard_hide: IconKeyboardHide,
  public: IconWorld,
  remove: IconMinus,
  terminal: IconTerminal2,
  visibility: IconEye,
};

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

export function SymbolView(props: SymbolViewProps) {
  if (Platform.OS !== "android") {
    return <ExpoSymbolView {...props} />;
  }

  const materialName = typeof props.name === "string" ? undefined : props.name.android;
  const sfSymbol = typeof props.name === "string" ? props.name : props.name.ios;
  const AndroidIcon =
    (materialName ? ANDROID_ICON_BY_MATERIAL_NAME[materialName] : undefined) ??
    (sfSymbol ? ANDROID_ICON_BY_SF_SYMBOL[sfSymbol] : undefined);

  if (!AndroidIcon) {
    return props.fallback ?? null;
  }

  return (
    <AndroidIcon
      accessibilityLabel={props.accessibilityLabel}
      color={props.tintColor}
      size={props.size}
      strokeWidth={2}
      style={props.style}
      testID={props.testID}
    />
  );
}
