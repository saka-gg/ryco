import { getPreferencesSnapshot, subscribePreferences } from "../state/preferencesStore";
import { rycoWidgetsNative } from "../widgets/rycoWidgetsNative";
import { clearLiveActivityPushTokens, setLiveActivityPushToken } from "./liveActivityTokenStore";

const loadBackgroundAlerts = () => import("../notifications/push/backgroundAlertsRuntime");

/**
 * Live Activity push updates (`docs/live-activity-push.md`), the app's half: follows the cards'
 * update tokens into the token store, which background alerts register with the Hub, and says
 * whether a new card should ask for one. That holds only while background alerts are on and
 * their Hub takes Live Activity updates; until then every card is local, as before.
 */
export function startMobileLiveActivityPush(input: {
  readonly setAvailable: (available: boolean) => void;
}): () => void {
  const native = rycoWidgetsNative();
  if (native === null) return () => undefined;
  const subscription = native.addListener?.("onAgentActivityPushToken", (event) =>
    setLiveActivityPushToken(event.id, event.token),
  );
  // A card an earlier launch left with a token reports it again.
  native.observeAgentActivityPushTokens?.();

  let stopped = false;
  let unsubscribeAlerts: (() => void) | null = null;
  const follow = () => {
    if (stopped || unsubscribeAlerts !== null) return;
    if (getPreferencesSnapshot().backgroundAlerts !== true) return;
    void loadBackgroundAlerts()
      .then(({ getMobileBackgroundAlerts }) => {
        if (stopped || unsubscribeAlerts !== null) return;
        const alerts = getMobileBackgroundAlerts();
        const read = () => input.setAvailable(alerts.getSnapshot().liveActivityUpdates);
        unsubscribeAlerts = alerts.subscribe(read);
        read();
      })
      .catch((error: unknown) => console.warn("Background alerts failed to load.", error));
  };
  const unsubscribePreferences = subscribePreferences(follow);
  follow();

  return () => {
    stopped = true;
    unsubscribePreferences();
    unsubscribeAlerts?.();
    subscription?.remove();
    // No listener hears a card end from here on: a token kept now would go with a later sign-in.
    clearLiveActivityPushTokens();
    input.setAvailable(false);
  };
}
