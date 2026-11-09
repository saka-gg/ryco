import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  SourceControlProviderDiscoveryItem,
  SourceControlRepositoryVisibility,
} from "@ryco/contracts";
import {
  getPublishProviderReadiness,
  isPublishRepositoryPathComplete,
  PUBLISH_PROVIDER_OPTIONS,
  publishAccountsByProvider,
  publishProviderOption,
  type PublishProviderKind,
} from "@ryco/shared/sourceControlPublish";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { errorMessageOr } from "../../lib/errorMessage";
import { ErrorBanner } from "../../components/ErrorBanner";
import { OptionRow } from "../../components/OptionRow";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { LoadingRow, PillButton, SectionTitle, ToolTextField } from "./gitToolsParts";
import { useSourceControlTarget, type SourceControlRouteParams } from "./useSourceControlTarget";

type PublishRouteProps = StaticScreenProps<SourceControlRouteParams>;

/**
 * Create the repository on a host the node is signed in to and push this
 * checkout there — the desktop's publish dialog, as one sheet.
 */
export function SourceControlPublishRouteScreen(props: PublishRouteProps) {
  const navigation = useNavigation();
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd, mutable } = target;
  const [providers, setProviders] =
    useState<ReadonlyArray<SourceControlProviderDiscoveryItem> | null>(null);
  const [provider, setProvider] = useState<PublishProviderKind>("github");
  const [repository, setRepository] = useState("");
  const [edited, setEdited] = useState(false);
  const [visibility, setVisibility] = useState<SourceControlRepositoryVisibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = useEnvironmentApi(environmentId);

  useEffect(() => {
    const server = api?.server;
    if (!server) return;
    let cancelled = false;
    void server.discoverSourceControl({ cached: true }).then(
      (result) => {
        if (cancelled) return;
        setProviders(result.sourceControlProviders);
        const firstReady = PUBLISH_PROVIDER_OPTIONS.find(
          (option) =>
            getPublishProviderReadiness({
              provider: option.value,
              sourceControlProviders: result.sourceControlProviders,
            }).ready,
        );
        if (firstReady) setProvider(firstReady.value);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOr(cause, "Hosts could not be checked."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const accounts = useMemo(() => publishAccountsByProvider(providers ?? []), [providers]);
  const readiness = getPublishProviderReadiness({
    provider,
    sourceControlProviders: providers ?? [],
  });
  const option = publishProviderOption(provider);
  const account = accounts[provider];

  useEffect(() => {
    if (!edited) setRepository(account ? `${account}/` : "");
  }, [account, edited]);

  const publish = async () => {
    if (!environmentId || !cwd) return;
    const input = { cwd, provider, repository: repository.trim(), visibility };
    setBusy(true);
    setError(null);
    try {
      const result =
        await ensureEnvironmentApi(environmentId).sourceControl.publishRepository(input);
      navigation.goBack();
      Alert.alert("Published", `${result.repository.nameWithOwner} is ready.`);
    } catch (cause) {
      setError(errorMessageOr(cause, "Publishing failed."));
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
    >
      <SectionTitle>Host</SectionTitle>
      {!providers && !error ? <LoadingRow label="Checking hosts…" /> : null}
      {providers ? (
        <View className="gap-2">
          {PUBLISH_PROVIDER_OPTIONS.map((candidate) => {
            const candidateReadiness = getPublishProviderReadiness({
              provider: candidate.value,
              sourceControlProviders: providers,
            });
            return (
              <OptionRow
                key={candidate.value}
                label={candidate.label}
                detail={candidateReadiness.hint ?? candidate.description}
                detailLines={2}
                selected={candidate.value === provider}
                disabled={!candidateReadiness.ready}
                onPress={() => {
                  setProvider(candidate.value);
                  setEdited(false);
                }}
              />
            );
          })}
        </View>
      ) : null}
      <SectionTitle>Repository</SectionTitle>
      <ToolTextField
        mono
        value={repository}
        onChangeText={(value) => {
          setEdited(true);
          setRepository(value);
        }}
        placeholder={option.pathPlaceholder}
        accessibilityLabel="Repository path"
      />
      <SegmentedControl
        value={visibility}
        onChange={setVisibility}
        options={[
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
        ]}
      />
      <Text className="px-1 text-[12px] leading-4 text-foreground-muted">
        Creates {repository.trim() || option.pathPlaceholder} on {option.host}, adds it as origin
        and pushes the current branch.
      </Text>
      {error ? <ErrorBanner message={error} /> : null}
      <PillButton
        label="Publish"
        symbol="square.and.arrow.up"
        busy={busy}
        disabled={!mutable || !readiness.ready || !isPublishRepositoryPathComplete(repository)}
        onPress={() => void publish()}
        className="mt-2"
      />
    </ScrollView>
  );
}
