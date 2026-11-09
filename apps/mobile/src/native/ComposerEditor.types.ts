import type { ServerProviderSkill } from "@ryco/contracts";
import type { Ref } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

export type ComposerEditorSelection = {
  readonly start: number;
  readonly end: number;
};

export interface ComposerEditorHandle {
  focus: () => void;
  blur: () => void;
  setSelection: (selection: ComposerEditorSelection) => void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly skills?: ReadonlyArray<
    Pick<ServerProviderSkill, "name" | "displayName" | "shortDescription" | "description">
  >;
  /** Titles of threads the draft mentions (`@thread:<id>`), by thread id, for their chips. */
  readonly threadTitles?: ReadonlyMap<string, string>;
  readonly selection?: ComposerEditorSelection;
  readonly placeholder?: string;
  /** What screen readers call the field (the placeholder disappears once there is text). */
  readonly accessibilityLabel?: string;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly scrollEnabled?: boolean;
  readonly autoCorrect?: boolean;
  readonly spellCheck?: boolean;
  readonly multiline?: boolean;
  readonly contentInsetVertical?: number;
  /** Android: center a single line vertically (collapsed pill); no-op on iOS. */
  readonly singleLineCentered?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: StyleProp<TextStyle>;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange?: (selection: ComposerEditorSelection) => void;
  readonly onPasteImages?: (uris: ReadonlyArray<string>) => void;
  /** The text's full height, insets included, as it changes: an owner can grow the field. */
  readonly onContentHeightChange?: (height: number) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /**
   * Invoked by the native iOS editor when Return or Command-Return is pressed
   * on a hardware keyboard; with it, Shift-Return inserts a new line. Without
   * it Return inserts a new line, as on the software keyboard.
   */
  readonly onSubmit?: () => void;
}
