import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { VcsRef } from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { errorMessageOr } from "../../lib/errorMessage";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  branchNameProblem,
  branchToCreate,
  buildBranchSections,
  type BranchRow,
} from "./gitToolsModel";
import { GroupCard, LoadingRow, SectionTitle, ToolRow, ToolTextField } from "./gitToolsParts";
import { useSourceControlTarget, type SourceControlRouteParams } from "./useSourceControlTarget";

type BranchesRouteProps = StaticScreenProps<SourceControlRouteParams>;

/** Refs the picker asks for at once; the search narrows the rest on the node. */
const BRANCH_PAGE_SIZE = 100;

/** A ref name the search asks the node for: whole words only, so typing never errors. */
function refQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : undefined;
}

/**
 * Switch the checkout to another branch, or create one from what is checked
 * out. Remote branches check out a local tracking branch; a branch checked out
 * in another worktree is shown but cannot be switched to here.
 */
export function SourceControlBranchesRouteScreen(props: BranchesRouteProps) {
  const navigation = useNavigation();
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd, mutable } = target;
  const [query, setQuery] = useState("");
  const [refs, setRefs] = useState<ReadonlyArray<VcsRef> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const checkColor = useThemeColor("--color-icon");
  const api = useEnvironmentApi(environmentId);

  useEffect(() => {
    if (!api || !cwd) return;
    let cancelled = false;
    const search = refQuery(query);
    const timer = setTimeout(
      () => {
        void api.vcs
          .listRefs({
            cwd,
            limit: BRANCH_PAGE_SIZE,
            ...(search ? { query: search } : {}),
          })
          .then(
            (result) => {
              if (!cancelled) setRefs(result.refs);
            },
            (cause: unknown) => {
              if (!cancelled) setError(errorMessageOr(cause, "Branches could not be listed."));
            },
          );
      },
      search ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, cwd, query]);

  const sections = useMemo(
    () => (refs && cwd ? buildBranchSections(refs, cwd) : null),
    [cwd, refs],
  );
  const createName = refs ? branchToCreate(query, refs) : null;
  const typedProblem = query.trim().length > 0 ? branchNameProblem(query) : null;

  const finish = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      navigation.goBack();
    } catch (cause) {
      setError(errorMessageOr(cause, `${label} failed.`));
      setBusy(null);
    }
  };

  const switchTo = (row: BranchRow) =>
    finish(`Switch to ${row.label}`, async () => {
      if (!environmentId || !cwd) return;
      await ensureEnvironmentApi(environmentId).vcs.switchRef({ cwd, refName: row.ref.name });
    });

  const create = (name: string) =>
    finish(`Create ${name}`, async () => {
      if (!environmentId || !cwd) return;
      await ensureEnvironmentApi(environmentId).vcs.createRef({
        cwd,
        refName: name,
        switchRef: true,
      });
    });

  if (!environmentId || !cwd) {
    return (
      <View className="flex-1 bg-sheet px-5 py-16">
        <EmptyState variant="plain" title="Workspace unavailable" detail="Reconnect and retry." />
      </View>
    );
  }

  const renderRows = (rows: ReadonlyArray<BranchRow>) =>
    rows.map((row, index) => (
      <ToolRow
        key={row.key}
        first={index === 0}
        symbol={row.ref.isRemote ? "cloud" : "arrow.triangle.branch"}
        title={row.label}
        detail={row.detail}
        disabled={!mutable || busy !== null || row.disabledReason !== null}
        onPress={row.current ? undefined : () => void switchTo(row)}
        trailing={
          row.current ? (
            <SymbolView
              name="checkmark"
              size={14}
              tintColor={checkColor as string}
              type="monochrome"
            />
          ) : undefined
        }
      />
    ));

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
    >
      <ToolTextField
        mono
        value={query}
        onChangeText={setQuery}
        placeholder="Search or name a new branch"
        returnKeyType="done"
        accessibilityLabel="Branch name"
        onSubmitEditing={() => {
          if (createName) void create(createName);
        }}
      />
      {error ? <ErrorBanner message={error} /> : null}
      {busy ? <Text className="px-1 text-[13px] text-foreground-muted">{busy}…</Text> : null}

      {createName ? (
        <GroupCard>
          <ToolRow
            first
            symbol="plus"
            title={`Create branch “${createName}”`}
            detail="From what is checked out now, then switch to it"
            disabled={!mutable || busy !== null}
            onPress={() => void create(createName)}
          />
        </GroupCard>
      ) : typedProblem && sections && sections.local.length + sections.remote.length === 0 ? (
        <Text className="px-1 text-[13px] text-foreground-muted">{typedProblem}</Text>
      ) : null}

      {!sections ? <LoadingRow label="Reading branches…" /> : null}
      {sections && sections.local.length > 0 ? (
        <View>
          <SectionTitle>Local</SectionTitle>
          <GroupCard>{renderRows(sections.local)}</GroupCard>
        </View>
      ) : null}
      {sections && sections.remote.length > 0 ? (
        <View>
          <SectionTitle>Remote</SectionTitle>
          <GroupCard>{renderRows(sections.remote)}</GroupCard>
        </View>
      ) : null}
      {sections && sections.local.length + sections.remote.length === 0 && !createName ? (
        <EmptyState variant="plain" title="No branches" detail="Nothing matches that name." />
      ) : null}
    </ScrollView>
  );
}
