import type { SendShortcut } from "@ryco/contracts";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettings } from "../../hooks/useSettings";
import { effectiveSendShortcut } from "./composerFollowUp";

/** A mouse or trackpad, among any of the device's pointers. */
export const FINE_POINTER_MEDIA_QUERY = "(any-pointer: fine)";

/**
 * The Send shortcut every prompt input applies with `resolveComposerEnter`: the setting, except
 * where `effectiveSendShortcut` keeps Enter sending. The pointer query is about input, not layout.
 */
export function useSendShortcut(): SendShortcut {
  const sendShortcut = useSettings((settings) => settings.sendShortcut);
  const phoneTier = usePresentationTier() === "phone";
  const finePointer = useMediaQuery(FINE_POINTER_MEDIA_QUERY);
  return effectiveSendShortcut(sendShortcut, { phoneTier, finePointer });
}
