"use client";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multi-line counterpart of `DraftInput`: buffers keystrokes locally and
 * invokes `onCommit` on blur or Cmd/Ctrl+Enter. Plain Enter adds a newline.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const bag = useCommitOnBlur<HTMLTextAreaElement>(value, onCommit, { multiline: true });
  return <Textarea {...rest} {...bag} />;
}
