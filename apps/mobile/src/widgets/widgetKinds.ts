/**
 * The widget kinds the app writes, one timeline file each in the App Group. Kept apart from the
 * widgets' models so the sign-in screen can empty them without loading those.
 */
export const SUBSCRIPTION_USAGE_WIDGET_KIND = "subscription-usage";

export const WIDGET_KINDS: readonly string[] = [SUBSCRIPTION_USAGE_WIDGET_KIND];
