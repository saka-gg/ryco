import { createElement } from "react";
import { FolderClosedIcon, TerminalIcon } from "lucide-react";
import { EDITORS, type EditorId } from "@ryco/contracts";
import {
  AntigravityIcon,
  CursorIcon,
  type Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import {
  AndroidStudioIcon,
  ExplorerIcon,
  FinderIcon,
  NovaIcon,
  PositronIcon,
  SublimeTextIcon,
  TerminalAppIcon,
  WindowsTerminalIcon,
  WindsurfIcon,
  XcodeIcon,
} from "../OpenAppIcons";
import { getEditorLabel } from "./editorLabels.logic";

// A failed load keeps the placeholder instead of throwing to an error boundary.
const QUIET_LOAD_ERROR = { onLoadError: () => undefined };

/**
 * An editor logo whose module loads the first time one renders. The JetBrains
 * logos are about 35 KiB of gradient SVG and the thread header's "Open in"
 * control shows at most one of them, so the thread route does not carry the
 * rest. Until the module arrives, or if its chunk fails to load, the icon is an
 * empty svg in the same box: a decorative logo never suspends a menu.
 */
function lazyIcon<Module>(load: () => Promise<Module>, pick: (module: Module) => Icon): Icon {
  const Loaded = preloadableLazy(() => load().then(pick));
  const LazyIcon: Icon = (props) => {
    const ready = useLazyComponentReady(Loaded, true, QUIET_LOAD_ERROR);
    return createElement(ready ? Loaded : "svg", props);
  };
  return LazyIcon;
}

const loadJetBrainsIcons = () => import("../JetBrainsIcons");

export const EDITOR_ICONS = {
  cursor: CursorIcon,
  windsurf: WindsurfIcon,
  trae: TraeIcon,
  kiro: KiroIcon,
  vscode: VisualStudioCode,
  "vscode-insiders": VisualStudioCodeInsiders,
  vscodium: VSCodium,
  positron: PositronIcon,
  zed: Zed,
  "sublime-text": SublimeTextIcon,
  nova: NovaIcon,
  xcode: XcodeIcon,
  antigravity: AntigravityIcon,
  "android-studio": AndroidStudioIcon,
  idea: lazyIcon(loadJetBrainsIcons, (icons) => icons.IntelliJIdeaIcon),
  aqua: lazyIcon(loadJetBrainsIcons, (icons) => icons.AquaIcon),
  clion: lazyIcon(loadJetBrainsIcons, (icons) => icons.CLionIcon),
  datagrip: lazyIcon(loadJetBrainsIcons, (icons) => icons.DataGripIcon),
  dataspell: lazyIcon(loadJetBrainsIcons, (icons) => icons.DataSpellIcon),
  goland: lazyIcon(loadJetBrainsIcons, (icons) => icons.GoLandIcon),
  phpstorm: lazyIcon(loadJetBrainsIcons, (icons) => icons.PhpStormIcon),
  pycharm: lazyIcon(loadJetBrainsIcons, (icons) => icons.PyCharmIcon),
  rider: lazyIcon(loadJetBrainsIcons, (icons) => icons.RiderIcon),
  rubymine: lazyIcon(loadJetBrainsIcons, (icons) => icons.RubyMineIcon),
  rustrover: lazyIcon(loadJetBrainsIcons, (icons) => icons.RustRoverIcon),
  webstorm: lazyIcon(loadJetBrainsIcons, (icons) => icons.WebStormIcon),
  terminal: TerminalIcon,
  "file-manager": FolderClosedIcon,
} satisfies Record<EditorId, Icon>;

export { getEditorLabel };

/** Icon of an editor target; the file manager uses the platform's own app icon. */
export function getEditorIcon(editor: EditorId, platform: string): Icon {
  if (editor === "file-manager") {
    if (isMacPlatform(platform)) return FinderIcon;
    if (isWindowsPlatform(platform)) return ExplorerIcon;
  }
  if (editor === "terminal") {
    if (isMacPlatform(platform)) return TerminalAppIcon;
    if (isWindowsPlatform(platform)) return WindowsTerminalIcon;
  }
  return EDITOR_ICONS[editor];
}

export function resolveEditorOptions(
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> {
  const available = new Set(availableEditors);
  return EDITORS.filter((editor) => available.has(editor.id)).map((editor) => ({
    label: getEditorLabel(editor.id, platform),
    Icon: getEditorIcon(editor.id, platform),
    value: editor.id,
  }));
}
