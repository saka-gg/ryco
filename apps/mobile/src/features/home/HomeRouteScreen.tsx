import { useEffect } from "react";

import { scheduleWorkspaceRoutePrewarm } from "../../navigation/lazyRouteScreens";
import { HomeScreen } from "./HomeScreen";

// Home route: the project/thread list on runtime-A state (spec Home row).
export function HomeRouteScreen() {
  // Home has painted by the time effects run; warm the next likely route.
  useEffect(scheduleWorkspaceRoutePrewarm, []);
  return <HomeScreen />;
}
