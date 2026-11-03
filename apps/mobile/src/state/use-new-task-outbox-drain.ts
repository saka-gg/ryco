import { useEffect } from "react";

/**
 * Mount point (RootStackLayout, beside the message outbox): New Tasks written
 * while their machine was away start once it is live. The outbox's code is
 * New Task's, so it loads after launch, inside the effect, rather than on the
 * launch path.
 */
export function useNewTaskOutboxDrain(): void {
  useEffect(
    () =>
      (
        require("../features/newTask/newTaskOutboxDrain") as typeof import("../features/newTask/newTaskOutboxDrain")
      ).startNewTaskOutboxDrain(),
    [],
  );
}
