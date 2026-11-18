import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  waitForStoreCondition,
  type ThreadGoalCommandPlan,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { Alert, Platform } from "react-native";

import { ensureEnvironmentApi, readEnvironmentApi } from "../../connection/environmentApi";
import { holdThreadOutboxForInterrupt } from "../../state/threadOutbox";
import {
  selectEnvironmentState,
  selectThreadByRef,
  selectThreadExistsByRef,
  selectWorkingDelegatedDescendants,
  useStore,
} from "../../state/threadsRuntime";
import { requeueNewTaskLaunch, retryNewTaskLaunch } from "../newTask/newTaskLaunch";
import { createNewTaskLaunchDeps } from "../newTask/newTaskLaunchRuntime";
import type { ProposedPlan } from "@ryco/client-runtime/state/threads";
import { planMarkdownExport, resolvePlanSavePath } from "./proposedPlanActions";
import { clearThreadGoal, interruptThreadTurn, setThreadGoal, trashThread } from "./sessionActions";
import {
  chatFolderForThreadDelete,
  scheduleChatFolderDelete,
  threadDeleteConfirmation,
} from "./threadDeleteModel";

/**
 * The thread screen's (`ThreadDetailScreen.tsx`) one-shot actions and prompts that hold no
 * state of their own: the screen calls them from its handlers with what they need.
 */

/** Runs one plan implementation; a tap while one is on its way does nothing. */
export async function guardPlanImplementation(
  inFlight: { current: boolean },
  run: () => Promise<void>,
): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    await run();
  } finally {
    inFlight.current = false;
  }
}

/** Resolves once the node's new thread reached this device (a few seconds at most). */
export async function waitForThreadInStore(environmentId: EnvironmentId, threadId: ThreadId) {
  await waitForStoreCondition({
    ready: (state) => selectThreadExistsByRef(state, scopeThreadRef(environmentId, threadId)),
    timeoutMs: 12_000,
  });
}

/** Sends what a `/goal` message asked for (a plan that changes something). */
export async function sendGoalPlan(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  plan: Extract<ThreadGoalCommandPlan, { kind: "set" | "clear" }>,
): Promise<void> {
  const api = ensureEnvironmentApi(environmentId);
  if (plan.kind === "clear") await clearThreadGoal(api, threadId);
  else await setThreadGoal(api, threadId, plan.update, { startTurn: plan.startTurn });
}

/** A New Task launch's Retry: start it again, or wait in the outbox while the machine is away. */
export function retryThreadNewTaskLaunch(environmentId: EnvironmentId, launchKey: string): void {
  let deps: ReturnType<typeof createNewTaskLaunchDeps>;
  try {
    deps = createNewTaskLaunchDeps(environmentId);
  } catch {
    // The machine is away: wait in the outbox and start once it is back.
    requeueNewTaskLaunch(launchKey);
    return;
  }
  retryNewTaskLaunch(launchKey, deps);
}

/** Asks for the chat's new title: a text prompt on iOS, `openSheet` (Android has none). */
export function promptThreadRename(
  current: string,
  save: (value: string | undefined) => void,
  openSheet: () => void,
): void {
  if (Platform.OS === "ios") {
    Alert.prompt(
      "Rename chat",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: save },
      ],
      "plain-text",
      current,
    );
  } else {
    openSheet();
  }
}

/** Asks where in the chat's folder a plan is saved, then `write`s it there. */
export function promptPlanSavePath(
  filename: string,
  write: (typed: string | undefined) => void,
): void {
  if (Platform.OS === "ios") {
    Alert.prompt(
      "Save plan",
      "A path inside the chat's folder. A file already there is replaced.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: write },
      ],
      "plain-text",
      filename,
    );
  } else {
    // Android has no text prompt: it saves under the plan's own name, once confirmed.
    Alert.alert(
      "Save plan?",
      `As ${filename} in the chat's folder. A file already there is replaced.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: () => write(filename) },
      ],
    );
  }
}

/**
 * A proposed plan's Save: asks where in the chat's folder (`root`) the Markdown goes and writes
 * it there through `runAction` (its busy state and failure alert).
 */
export function saveProposedPlan(
  plan: ProposedPlan,
  input: {
    readonly environmentId: EnvironmentId;
    readonly root: string | null;
    readonly runAction: (action: () => Promise<void>, failureTitle: string) => Promise<unknown>;
  },
): void {
  const { environmentId, root, runAction } = input;
  if (!root) {
    Alert.alert("Can't save the plan", "This chat has no folder on its machine yet.");
    return;
  }
  const { filename, contents } = planMarkdownExport(plan.planMarkdown);
  const write = (typed: string | undefined) => {
    const relativePath = resolvePlanSavePath(typed);
    if (relativePath === null) {
      Alert.alert("Can't save there", "Use a path inside the chat's folder.");
      return;
    }
    void runAction(async () => {
      await ensureEnvironmentApi(environmentId).projects.writeFile({
        cwd: root,
        relativePath,
        contents,
      });
      Alert.alert("Plan saved", relativePath);
    }, "Could not save the plan");
  };
  promptPlanSavePath(filename, write);
}

/** Confirms clearing the chat's goal. */
export function confirmClearThreadGoal(clear: () => void): void {
  Alert.alert("Clear goal?", "The agent stops pursuing it.", [
    { text: "Cancel", style: "cancel" },
    { text: "Clear", style: "destructive", onPress: clear },
  ]);
}

/**
 * Confirms a Delete: the node trashes the chat and purges it shortly after, with its
 * attachments and terminal history. The last conversation of a "No project" chat also offers
 * "Delete with files" (web's "Also delete files"); plain Delete keeps the chat's folder.
 * `run` wraps the delete in the screen's failure handling; `after` runs once it succeeded.
 */
export function confirmDeleteThread(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly run: (action: () => Promise<void>) => void;
  readonly after: () => void;
}): void {
  const { environmentId, threadId } = input;
  const folder = chatFolderForThreadDelete(
    selectEnvironmentState(useStore.getState(), environmentId),
    environmentId,
    threadId,
  );
  const confirmation = threadDeleteConfirmation(input.title, folder);
  const remove = (deleteFiles: boolean) =>
    input.run(async () => {
      await trashThread(ensureEnvironmentApi(environmentId), threadId);
      if (deleteFiles && folder !== null) {
        scheduleChatFolderDelete({
          target: folder,
          threadId,
          readEnvironment: () => selectEnvironmentState(useStore.getState(), environmentId),
          resolveDeleteChatFolder: () =>
            readEnvironmentApi(environmentId)?.projects.deleteChatFolder,
          alert: (title, message) => Alert.alert(title, message),
        });
      }
      input.after();
    });
  Alert.alert(confirmation.title, confirmation.message, [
    { text: "Cancel", style: "cancel" },
    ...(confirmation.deleteWithFiles === null
      ? []
      : [
          {
            text: confirmation.deleteWithFiles.label,
            style: "destructive" as const,
            onPress: () => remove(true),
          },
        ]),
    { text: "Delete", style: "destructive", onPress: () => remove(false) },
  ]);
}

/**
 * A Stop ends this chat's turn and the automatic return of its delegated results, but its
 * delegated tasks keep working. Offer to stop those too, deepest first, each like a Stop of
 * its own chat (its outbox holds).
 */
export function offerToStopDelegatedTasks(environmentId: EnvironmentId, threadId: ThreadId): void {
  const working = selectWorkingDelegatedDescendants(
    useStore.getState(),
    scopeThreadRef(environmentId, threadId),
  );
  if (working.length === 0) return;
  const count = working.length;
  Alert.alert(
    "Stopped",
    count === 1
      ? "A task this chat delegated is still working."
      : `${count} tasks this chat delegated are still working.`,
    [
      { text: "Keep it running", style: "cancel" },
      {
        text: count === 1 ? "Stop it too" : "Stop them too",
        style: "destructive",
        onPress: () => {
          void (async () => {
            let failed = 0;
            for (const ref of working) {
              const held = holdThreadOutboxForInterrupt(
                scopedThreadKey(ref),
                selectThreadByRef(useStore.getState(), ref)?.session?.activeTurnId ?? null,
              );
              try {
                await interruptThreadTurn(ensureEnvironmentApi(ref.environmentId), ref.threadId);
              } catch {
                held.undo();
                failed += 1;
              }
            }
            if (failed > 0) {
              Alert.alert(
                failed === 1
                  ? "A task could not be stopped"
                  : `${failed} tasks could not be stopped`,
                "Open the task to stop it there.",
              );
            }
          })();
        },
      },
    ],
  );
}
