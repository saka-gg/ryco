import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { selectThreadTerminalState } from "@ryco/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { firstRouteParam } from "../../lib/routeParams";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { errorMessageOr } from "../../lib/errorMessage";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useTerminalStateStore } from "../../state/terminalStateStore";
import { selectProjectByRef, selectThreadByRef, useStore } from "../../state/threadsRuntime";
import { useThreadWorkspaceRoot } from "../files/useThreadWorkspaceRoot";
import { useEnvironmentMutationReady } from "../home/useEnvironmentMutationReady";
import {
  GroupCard,
  PillButton,
  SectionTitle,
  ToolRow,
  ToolTextField,
} from "../sourceControl/gitToolsParts";
import {
  canCreateMobileTerminalSession,
  createMobileTerminalId,
} from "../terminal/terminalSessionModel";
import { findThreadWorktree } from "../threads/threadHeaderModel";
import { runScriptInTerminal } from "./runScriptInTerminal";
import { scriptRows, scriptRunRequest, type ScriptRunRequest } from "./projectScriptsModel";

type ThreadScriptsRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * Opens a new terminal of the thread and types the command into it once its
 * shell is ready. A failed run forgets the terminal again, so it neither
 * lingers in the tabs nor counts toward the phone's terminal limit.
 */
async function runInNewTerminal(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: ScriptRunRequest;
}): Promise<void> {
  const terminalId = createMobileTerminalId(uuidv4());
  const threadRef = scopeThreadRef(input.environmentId, input.threadId);
  useTerminalStateStore.getState().newTerminal(threadRef, terminalId);
  try {
    await runScriptInTerminal({
      api: ensureEnvironmentApi(input.environmentId).terminal,
      threadId: input.threadId,
      terminalId,
      request: input.request,
    });
  } catch (cause) {
    useTerminalStateStore.getState().closeTerminal(threadRef, terminalId);
    throw cause;
  }
}

/**
 * Run one of the project's scripts — or any one-off command — in a new
 * terminal of this thread, then show that terminal.
 */
export function ThreadScriptsRouteScreen(props: ThreadScriptsRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(firstRouteParam(props.route.params.environmentId) ?? "");
  const threadId = ThreadId.make(firstRouteParam(props.route.params.threadId) ?? "");
  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  const { worktrees } = useHomeWorkspaceData();
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const cwd = useThreadWorkspaceRoot({ thread, worktree, project });
  const worktreePath = worktree?.worktreePath ?? thread?.worktreePath ?? null;
  const terminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(
        state.terminalStateByThreadKey,
        scopeThreadRef(environmentId, threadId),
      ).terminalIds,
  );
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const symbolColor = useThemeColor("--color-icon");
  const rows = useMemo(() => scriptRows(project ? project.scripts : []), [project]);
  const roomForTerminal = canCreateMobileTerminalSession(terminalIds);
  const mutable = useEnvironmentMutationReady(environmentId);

  const run = async (name: string, scriptCommand: string) => {
    if (!project || !cwd || busy !== null || !roomForTerminal || !mutable) return;
    const request = scriptRunRequest({
      command: scriptCommand,
      projectCwd: project.cwd,
      workspaceCwd: cwd,
      worktreePath,
    });
    if (!request) return;
    setBusy(name);
    setError(null);
    try {
      await runInNewTerminal({ environmentId, threadId, request });
      // The sheet becomes the terminal, so Back returns to whatever opened the sheet.
      navigation.dispatch(StackActions.replace("ThreadTerminal", { environmentId, threadId }));
    } catch (cause) {
      setError(errorMessageOr(cause, `Could not run ${name}.`));
      setBusy(null);
    }
  };

  if (!thread || !project || !cwd) {
    return (
      <View className="flex-1 bg-sheet px-5 py-16">
        <EmptyState
          variant="plain"
          title="Workspace unavailable"
          detail="This thread's workspace has not loaded yet."
        />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {!roomForTerminal ? (
        <ErrorBanner message="This thread has the most terminals the phone opens. Close one in Terminal first." />
      ) : null}
      <View>
        <SectionTitle>{project.name}</SectionTitle>
        {rows.length > 0 ? (
          <GroupCard>
            {rows.map((row, index) => (
              <ToolRow
                key={row.id}
                first={index === 0}
                symbol={row.symbol as AppSymbolName}
                title={busy === row.name ? `Starting ${row.name}…` : row.name}
                detail={row.setup ? `${row.command} · runs on new worktrees` : row.command}
                disabled={busy !== null || !roomForTerminal || !mutable}
                onPress={() => void run(row.name, row.command)}
                trailing={
                  <SymbolView
                    name="play.fill"
                    size={12}
                    tintColor={symbolColor as string}
                    type="monochrome"
                  />
                }
              />
            ))}
          </GroupCard>
        ) : (
          <Text className="px-1 text-[13px] leading-5 text-foreground-muted">
            This project has no scripts yet. Add them in the project's settings, or run a command
            below.
          </Text>
        )}
      </View>
      <View className="gap-2">
        <SectionTitle>Run a command</SectionTitle>
        <ToolTextField
          mono
          value={command}
          onChangeText={setCommand}
          placeholder="bun run dev"
          accessibilityLabel="Command"
          returnKeyType="go"
          onSubmitEditing={() => void run("command", command)}
        />
        <Text className="px-1 text-[12px] leading-4 text-foreground-muted">
          Runs in a new terminal in {worktreePath ? "this thread's worktree" : "the project folder"}
          .
        </Text>
        <PillButton
          label="Run"
          symbol="play.fill"
          busy={busy === "command"}
          disabled={busy !== null || !roomForTerminal || !mutable || command.trim().length === 0}
          onPress={() => void run("command", command)}
        />
      </View>
    </ScrollView>
  );
}
