import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals([
  "direct-path",
  "goto",
  "line",
  "line-column",
  "nova-line-column",
]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly platforms?: readonly ["darwin" | "linux" | "win32", ...("darwin" | "linux" | "win32")[]];
  readonly platformLauncher?: "file-manager" | "terminal";
  readonly workspaceOnly?: boolean;
};

export const EDITORS = [
  { id: "cursor", label: "Cursor", commands: ["cursor"], launchStyle: "goto" },
  { id: "windsurf", label: "Windsurf", commands: ["windsurf"], launchStyle: "goto" },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  { id: "vscode", label: "VS Code", commands: ["code"], launchStyle: "goto" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
  },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], launchStyle: "goto" },
  { id: "positron", label: "Positron", commands: ["positron"], launchStyle: "goto" },
  { id: "zed", label: "Zed", commands: ["zed", "zeditor"], launchStyle: "direct-path" },
  { id: "sublime-text", label: "Sublime Text", commands: ["subl"], launchStyle: "direct-path" },
  {
    id: "nova",
    label: "Nova",
    commands: ["nova"],
    launchStyle: "nova-line-column",
    platforms: ["darwin"],
  },
  {
    id: "xcode",
    label: "Xcode",
    commands: ["xed"],
    launchStyle: "line",
    platforms: ["darwin"],
  },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], launchStyle: "goto" },
  {
    id: "android-studio",
    label: "Android Studio",
    commands: ["studio", "studio64", "studio.exe", "studio64.exe"],
    launchStyle: "line-column",
  },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], launchStyle: "line-column" },
  { id: "clion", label: "CLion", commands: ["clion"], launchStyle: "line-column" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], launchStyle: "line-column" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], launchStyle: "line-column" },
  { id: "goland", label: "GoLand", commands: ["goland"], launchStyle: "line-column" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], launchStyle: "line-column" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], launchStyle: "line-column" },
  { id: "rider", label: "Rider", commands: ["rider"], launchStyle: "line-column" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], launchStyle: "line-column" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], launchStyle: "line-column" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], launchStyle: "line-column" },
  {
    id: "terminal",
    label: "Terminal",
    commands: null,
    launchStyle: "direct-path",
    platformLauncher: "terminal",
    workspaceOnly: true,
  },
  {
    id: "file-manager",
    label: "File Manager",
    commands: null,
    launchStyle: "direct-path",
    platformLauncher: "file-manager",
  },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;

export class OpenError extends Schema.TaggedError<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
