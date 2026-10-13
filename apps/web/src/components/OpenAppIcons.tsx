import androidStudioIcon from "../assets/editor-icons/android-studio.png";
import explorerIcon from "../assets/editor-icons/explorer.svg";
import finderIcon from "../assets/editor-icons/finder.png";
import novaIcon from "../assets/editor-icons/nova.png";
import positronIcon from "../assets/editor-icons/positron.png";
import sublimeTextIcon from "../assets/editor-icons/sublime-text.png";
import windsurfIcon from "../assets/editor-icons/windsurf.png";
import terminalIcon from "../assets/editor-icons/terminal.png";
import windowsTerminalIcon from "../assets/editor-icons/windows-terminal.png";
import xcodeIcon from "../assets/editor-icons/xcode.png";
import type { Icon } from "./Icons";

function createOriginalAppIcon(source: string, title: string): Icon {
  const OriginalAppIcon: Icon = (props) => (
    <svg {...props} viewBox="0 0 24 24" fill="none">
      <title>{title}</title>
      <image href={source} width="24" height="24" preserveAspectRatio="xMidYMid meet" />
    </svg>
  );
  OriginalAppIcon.displayName = `${title.replaceAll(" ", "")}Icon`;
  return OriginalAppIcon;
}

export const AndroidStudioIcon = createOriginalAppIcon(androidStudioIcon, "Android Studio");
export const XcodeIcon = createOriginalAppIcon(xcodeIcon, "Xcode");
export const WindsurfIcon = createOriginalAppIcon(windsurfIcon, "Windsurf");
export const SublimeTextIcon = createOriginalAppIcon(sublimeTextIcon, "Sublime Text");
export const NovaIcon = createOriginalAppIcon(novaIcon, "Nova");
export const PositronIcon = createOriginalAppIcon(positronIcon, "Positron");
export const FinderIcon = createOriginalAppIcon(finderIcon, "Finder");
export const ExplorerIcon = createOriginalAppIcon(explorerIcon, "File Explorer");
export const TerminalAppIcon = createOriginalAppIcon(terminalIcon, "Terminal");
export const WindowsTerminalIcon = createOriginalAppIcon(windowsTerminalIcon, "Windows Terminal");
