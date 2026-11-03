import { Alert } from "react-native";
import {
  STOP_BACKGROUND_WORK_CONFIRM_LABEL,
  STOP_BACKGROUND_WORK_TITLE,
  describeModelSwitchBlockedByBackgroundWork,
  type CommitSendTurnDispatchInput,
} from "@ryco/client-runtime/state/composer";

/**
 * The "Stop tasks and switch" choice of a send whose model switch the
 * thread's background tasks hold back (the shared flow lives in the send
 * engine). Dismissing the alert cancels.
 */
export const mobileConfirmStopBackgroundWork: NonNullable<
  CommitSendTurnDispatchInput["confirmStopBackgroundWork"]
> = (blocked) =>
  new Promise((resolve) => {
    Alert.alert(
      STOP_BACKGROUND_WORK_TITLE,
      describeModelSwitchBlockedByBackgroundWork(blocked),
      [
        {
          text: STOP_BACKGROUND_WORK_CONFIRM_LABEL,
          style: "destructive",
          onPress: () => resolve(true),
        },
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
