import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const readVisible = () => document.visibilityState !== "hidden";
const readVisibleOnServer = () => true;

/** Whether the page is visible: false in a background tab or a minimized window. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, readVisible, readVisibleOnServer);
}
