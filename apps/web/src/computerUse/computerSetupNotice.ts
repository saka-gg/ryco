import { toastManager } from "../components/ui/toast";

let shown = false;

/** Once per app session: a default send went without Computer Use because setup is unfinished. */
export function noteComputerSetupMissingOnce(): void {
  if (shown) return;
  shown = true;
  toastManager.add({
    type: "info",
    title: "Computer Use needs setup",
    description: "This message was sent without it. Finish setup in Settings → Computer Use.",
  });
}
