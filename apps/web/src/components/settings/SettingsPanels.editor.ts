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
import {
  AndroidStudioIcon,
  NovaIcon,
  PositronIcon,
  SublimeTextIcon,
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

export function resolveEditorOptions(
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> {
  const available = new Set(availableEditors);
  return EDITORS.filter((editor) => available.has(editor.id)).map((editor) => ({
    label: getEditorLabel(editor.id, platform),
    Icon: EDITOR_ICONS[editor.id],
    value: editor.id,
  }));
}
