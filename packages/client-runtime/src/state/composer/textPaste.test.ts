import { describe, expect, it } from "vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@ryco/contracts/orchestration";

import {
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  isPasteAsTextShortcut,
  isPastedTextAttachment,
  nextPastedTextFileName,
  resolvePastedTextDisposition,
  wouldTextPasteExceedInputLimit,
  type PasteShortcutKeyEvent,
} from "./textPaste.ts";

const fold = (
  text: string,
  overrides: Partial<Parameters<typeof resolvePastedTextDisposition>[0]> = {},
) =>
  resolvePastedTextDisposition({
    text,
    canAttach: true,
    pasteAsText: false,
    wouldExceedInputLimit: false,
    ...overrides,
  });

describe("resolvePastedTextDisposition", () => {
  it("keeps ordinary pastes inline and folds them from the threshold on", () => {
    expect(fold("const answer = 42;\n".repeat(200))).toBe("inline");
    expect(fold("a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD - 1))).toBe("inline");
    expect(fold("a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD))).toBe("attachment");
  });

  it("counts UTF-8 bytes, so text that encodes large folds before its length does", () => {
    // Three bytes per character: a third of the threshold in characters reaches it in bytes.
    const cjk = "漢".repeat(Math.ceil(PASTED_TEXT_ATTACHMENT_THRESHOLD / 3));
    expect(cjk.length).toBeLessThan(PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(fold(cjk)).toBe("attachment");
    expect(fold("漢".repeat(Math.floor(PASTED_TEXT_ATTACHMENT_THRESHOLD / 3) - 1))).toBe("inline");
  });

  it("folds a small paste that would push the prompt past the input limit", () => {
    expect(fold("short", { wouldExceedInputLimit: true })).toBe("attachment");
  });

  it("keeps the paste inline for the paste-as-text shortcut or when nothing can be attached", () => {
    const large = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(fold(large, { pasteAsText: true })).toBe("inline");
    expect(fold(large, { canAttach: false, wouldExceedInputLimit: true })).toBe("inline");
    expect(fold("", { wouldExceedInputLimit: true })).toBe("inline");
  });
});

describe("wouldTextPasteExceedInputLimit", () => {
  it("measures the prompt after the paste replaces the selection", () => {
    expect(
      wouldTextPasteExceedInputLimit({
        promptLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10,
        selectedLength: 0,
        pastedLength: 10,
      }),
    ).toBe(false);
    expect(
      wouldTextPasteExceedInputLimit({
        promptLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10,
        selectedLength: 0,
        pastedLength: 11,
      }),
    ).toBe(true);
    expect(
      wouldTextPasteExceedInputLimit({
        promptLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
        selectedLength: 20,
        pastedLength: 20,
      }),
    ).toBe(false);
    expect(
      wouldTextPasteExceedInputLimit({
        promptLength: 10,
        selectedLength: 4,
        pastedLength: 7,
        maxLength: 12,
      }),
    ).toBe(true);
  });
});

describe("nextPastedTextFileName", () => {
  it("names folded pastes in sequence past the attached names, case-insensitively", () => {
    expect(nextPastedTextFileName([])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["notes.md"])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["Pasted-Text.txt"])).toBe("pasted-text-2.txt");
    expect(nextPastedTextFileName(["pasted-text.txt", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
    expect(nextPastedTextFileName(["pasted-text.txt", "pasted-text-3.txt"])).toBe(
      "pasted-text-2.txt",
    );
  });

  it("recognizes a folded paste by its name and type", () => {
    expect(isPastedTextAttachment({ name: "pasted-text.txt", mimeType: "text/plain" })).toBe(true);
    expect(isPastedTextAttachment({ name: "pasted-text-12.txt", mimeType: "text/plain" })).toBe(
      true,
    );
    expect(isPastedTextAttachment({ name: "notes.txt", mimeType: "text/plain" })).toBe(false);
    expect(isPastedTextAttachment({ name: "pasted-text.txt", mimeType: "text/markdown" })).toBe(
      false,
    );
  });
});

describe("isPasteAsTextShortcut", () => {
  const key = (init: Partial<PasteShortcutKeyEvent>) => ({
    key: "v",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });

  it("is Cmd+Shift+V on macOS and Ctrl+Shift+V elsewhere", () => {
    expect(isPasteAsTextShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isPasteAsTextShortcut(key({ key: "V", metaKey: true, shiftKey: true }), true)).toBe(
      true,
    );
    expect(isPasteAsTextShortcut(key({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPasteAsTextShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isPasteAsTextShortcut(key({ metaKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("is not a plain paste or another chord", () => {
    expect(isPasteAsTextShortcut(key({ metaKey: true }), true)).toBe(false);
    expect(isPasteAsTextShortcut(key({ metaKey: true, shiftKey: true, altKey: true }), true)).toBe(
      false,
    );
    expect(isPasteAsTextShortcut(key({ key: "c", metaKey: true, shiftKey: true }), true)).toBe(
      false,
    );
  });
});
