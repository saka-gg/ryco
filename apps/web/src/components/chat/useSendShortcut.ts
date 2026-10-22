import type { SendShortcut } from "@ryco/contracts";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettings } from "../../hooks/useSettings";
import { effectiveSendShortcut } from "./composerFollowUp";

/**
 * The Send shortcut every prompt input applies with `resolveComposerEnter`: the setting, except
 * where `effectiveSendShortcut` keeps Enter sending. The pointer query is about input, not layout.
 */
export function useSendShortcut(): SendShortcut {
  const sendShortcut = useSettings((settings) => settings.sendShortcut);
  const phoneTier = usePresentationTier() === "phone";
  const finePointer = useMediaQuery("(any-pointer: fine)");
  return effectiveSendShortcut(sendShortcut, { phoneTier, finePointer });
}
