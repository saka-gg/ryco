import { useEffect } from "react";

import { retainMessageQueueDrain } from "../messageQueueDrain";

/** Keeps the follow-up queue draining for every thread, on screen or not. */
export function MessageQueueDrainBridge() {
  useEffect(() => retainMessageQueueDrain(), []);
  return null;
}
