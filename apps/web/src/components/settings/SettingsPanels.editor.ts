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
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { getEditorLabel } from "./editorLabels.logic";

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
  idea: IntelliJIdeaIcon,
  aqua: AquaIcon,
  clion: CLionIcon,
  datagrip: DataGripIcon,
  dataspell: DataSpellIcon,
  goland: GoLandIcon,
  phpstorm: PhpStormIcon,
  pycharm: PyCharmIcon,
  rider: RiderIcon,
  rubymine: RubyMineIcon,
  rustrover: RustRoverIcon,
  webstorm: WebStormIcon,
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
