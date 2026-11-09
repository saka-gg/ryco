import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  describeThreadLocalServerStopFailure,
  watchThreadLocalServers,
} from "@ryco/client-runtime/rpc/threadLocalServers";
import { normalizeBrowserUrl } from "@ryco/shared/browserUrl";
import type { ThreadLocalServerList } from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { firstRouteParam } from "../../lib/routeParams";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { errorMessageOr } from "../../lib/errorMessage";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useEnvironmentMutationReady } from "../home/useEnvironmentMutationReady";
import {
  GroupCard,
  LoadingRow,
  PillButton,
  SectionTitle,
  ToolRow,
  ToolTextField,
} from "../sourceControl/gitToolsParts";
import { nodeBrowserUnavailableMessage, serverRows } from "./browserPreviewModel";

type ThreadServersRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function addressProblem(value: string): string | null {
  try {
    normalizeBrowserUrl(value);
    return null;
  } catch (cause) {
    return errorMessageOr(cause, "Enter an address.");
  }
}

/**
 * The dev servers this thread started on the machine — preview one in the
 * machine's browser or stop it — and any other address to preview.
 * `localhost` is the machine's, never the phone's.
 */
export function ThreadServersRouteScreen(props: ThreadServersRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(firstRouteParam(props.route.params.environmentId) ?? "");
  const threadId = ThreadId.make(firstRouteParam(props.route.params.threadId) ?? "");
  const threads = useEnvironmentApi(environmentId)?.threads;
  const config = useEnvironmentServerConfigs().get(environmentId) ?? null;
  const capabilities = config ? config.environment.capabilities : null;
  const listsServers = capabilities?.threadLocalServers === true;
  const stopsServers = capabilities?.threadLocalServerStop === true;
  const previewAvailable = config?.nodeBrowser?.available === true;
  const mutable = useEnvironmentMutationReady(environmentId);
  const [list, setList] = useState<ThreadLocalServerList | null>(null);
  const [address, setAddress] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subscribe = threads?.subscribeLocalServers;
    if (!subscribe || !listsServers) return;
    return watchThreadLocalServers(subscribe, threadId, setList);
  }, [listsServers, threadId, threads]);

  const rows = useMemo(() => serverRows(list ? list.servers : []), [list]);

  const preview = (url: string) =>
    navigation.dispatch(
      StackActions.replace("ThreadBrowser", {
        environmentId,
        threadId,
        url: normalizeBrowserUrl(url),
      }),
    );

  const stop = (key: string) => {
    const server = list?.servers.find(
      (candidate) => `${candidate.pid}:${candidate.startTimeMs}:${candidate.port}` === key,
    );
    const stopServer = threads?.stopLocalServer;
    if (!server || !stopServer || !mutable) return;
    setStopping(key);
    setError(null);
    void stopServer({
      threadId,
      pid: server.pid,
      startTimeMs: server.startTimeMs,
      port: server.port,
    })
      .catch((cause: unknown) => setError(describeThreadLocalServerStopFailure(cause)))
      .finally(() => setStopping(null));
  };

  const typedProblem = address.trim().length > 0 ? addressProblem(address) : null;

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {!previewAvailable ? (
        <Text className="px-1 text-[13px] leading-5 text-foreground-muted">
          {nodeBrowserUnavailableMessage(config?.nodeBrowser ?? null)}
        </Text>
      ) : null}
      <View>
        <SectionTitle>Started by this thread</SectionTitle>
        {!listsServers ? (
          <Text className="px-1 text-[13px] text-foreground-muted">
            Update Ryco on this machine to see the servers a thread starts.
          </Text>
        ) : !list ? (
          <LoadingRow label="Looking for servers…" />
        ) : rows.length === 0 ? (
          <EmptyState
            variant="card"
            title="No servers running"
            detail="Servers the agent or a terminal of this thread starts show up here."
          />
        ) : (
          <GroupCard>
            {rows.map((row, index) => (
              <ToolRow
                key={row.key}
                first={index === 0}
                symbol="server.rack"
                title={row.title}
                detail={row.detail}
                disabled={!previewAvailable}
                onPress={() => preview(row.url)}
                trailing={
                  stopsServers ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Stop ${row.title}`}
                      disabled={stopping !== null || !mutable}
                      onPress={() => stop(row.key)}
                      hitSlop={6}
                      className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
                    >
                      <Text className="text-[12px] font-ryco-bold text-danger-foreground">
                        {stopping === row.key ? "Stopping…" : "Stop"}
                      </Text>
                    </Pressable>
                  ) : undefined
                }
              />
            ))}
          </GroupCard>
        )}
      </View>
      {previewAvailable ? (
        <View className="gap-2">
          <SectionTitle>Preview an address</SectionTitle>
          <ToolTextField
            mono
            value={address}
            onChangeText={setAddress}
            placeholder="localhost:3000"
            accessibilityLabel="Address to preview"
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (address.trim() && !typedProblem) preview(address);
            }}
          />
          {typedProblem ? (
            <Text className="px-1 text-[12px] text-foreground-muted">{typedProblem}</Text>
          ) : null}
          <PillButton
            label="Preview"
            symbol="safari"
            disabled={address.trim().length === 0 || typedProblem !== null}
            onPress={() => preview(address)}
          />
          <Text className="px-1 text-[12px] leading-4 text-foreground-muted">
            Opens in the machine's browser, so localhost is the machine.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
