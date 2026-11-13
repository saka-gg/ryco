/**
 * The node's `promptSuggestions` setting as the Claude and Codex adapters read it: live, on each
 * session open (Claude) or completed turn (Codex). An unreadable settings file keeps it off, since
 * each suggestion is an extra model request on the user's plan.
 */
import * as Effect from "effect/Effect";

import type { ServerSettingsShape } from "../serverSettings.ts";

export const readPromptSuggestionsSetting = (
  settings: Pick<ServerSettingsShape, "getSettings">,
): Effect.Effect<boolean> =>
  settings.getSettings.pipe(
    Effect.map((current) => current.promptSuggestions),
    Effect.orElseSucceed(() => false),
  );
