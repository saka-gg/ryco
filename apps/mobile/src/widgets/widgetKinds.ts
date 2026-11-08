/**
 * The widget kinds the app writes, one timeline file each in the App Group. Kept apart from the
 * widgets' models so the sign-in screen can empty them without loading those.
 */
export const SUBSCRIPTION_USAGE_WIDGET_KIND = "subscription-usage";
/** Running threads and those that need you (`agentWidgetTimeline.ts`, `AgentWidget.swift`). */
export const AGENT_WIDGET_KIND = "agent-activity";

export const WIDGET_KINDS: readonly string[] = [SUBSCRIPTION_USAGE_WIDGET_KIND, AGENT_WIDGET_KIND];
