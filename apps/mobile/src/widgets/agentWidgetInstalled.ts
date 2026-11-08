import { rycoWidgetsNative } from "./rycoWidgetsNative";
import { AGENT_WIDGET_KIND } from "./widgetKinds";

/**
 * Whether the agent widget is on a Home or Lock Screen. False in a build without widgets and in
 * binaries older than the check. Loaded after launch, with the Live Activity bridge's idle work.
 */
export async function isAgentWidgetInstalled(): Promise<boolean> {
  const read = rycoWidgetsNative()?.installedWidgetKinds;
  if (read === undefined) return false;
  return (await read()).includes(AGENT_WIDGET_KIND);
}
