import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "@ryco/shared/thirdPartyLicenses";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import { SettingsRow } from "./components/SettingsRow";
import { loadMobileThirdPartyLicenses } from "./mobileThirdPartyLicenses";

function LicenseRow(props: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly first: boolean;
  readonly last: boolean;
  readonly onOpen: (entry: ThirdPartyLicenseEntry) => void;
}) {
  return (
    <View
      className={`mx-4 overflow-hidden bg-card ${props.first ? "rounded-t-[22px]" : ""} ${
        props.last ? "rounded-b-[22px]" : ""
      }`}
    >
      <SettingsRow
        first={props.first}
        label={props.entry.name}
        detail={props.entry.license}
        value={props.entry.version ?? undefined}
        onPress={() => props.onOpen(props.entry)}
      />
    </View>
  );
}

/**
 * Settings > About > Open source licenses: every third-party package and native library the app
 * ships, searchable by name or license. The notices load on this screen's first render.
 */
export function SettingsOpenSourceLicensesRouteScreen() {
  const navigation = useNavigation();
  const [query, setQuery] = useState("");
  const placeholderColor = useThemeColor("--color-foreground-tertiary");
  const iconColor = useThemeColor("--color-icon-subtle");
  const manifest = loadMobileThirdPartyLicenses();
  const entries = manifest ? filterThirdPartyLicenseEntries(manifest.entries, query) : [];
  const open = (entry: ThirdPartyLicenseEntry) =>
    navigation.navigate("SettingsOpenSourceLicense", {
      entryKey: thirdPartyLicenseEntryKey(entry),
    });
  const renderItem = ({ item, index }: LegendListRenderItemProps<ThirdPartyLicenseEntry>) => (
    <LicenseRow
      entry={item}
      first={index === 0}
      last={index === entries.length - 1}
      onOpen={open}
    />
  );

  if (!manifest) {
    return (
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title="Licenses unavailable"
          detail="This build does not include its open source license notices."
        />
      </View>
    );
  }

  const header = (
    <View className="gap-3 px-4 pt-3 pb-4">
      <View className="h-11 flex-row items-center gap-2 rounded-xl bg-card px-3">
        <SymbolView name="magnifyingglass" size={15} tintColor={iconColor} type="monochrome" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or license"
          placeholderTextColor={placeholderColor as string}
          accessibilityLabel="Search open source licenses"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          className="min-w-0 flex-1 font-sans text-[16px] text-foreground"
        />
      </View>
      <Text className="px-2 font-sans text-xs leading-4 text-foreground-muted">
        Ryco is built with these open source packages and libraries. Tap one for its license.
      </Text>
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      <LegendList
        data={entries}
        renderItem={renderItem}
        keyExtractor={thirdPartyLicenseEntryKey}
        estimatedItemSize={68}
        recycleItems
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View className="px-2 py-12">
            <EmptyState
              variant="plain"
              title="Nothing matches"
              detail="Search by package name or license, such as MIT."
            />
          </View>
        }
      />
    </View>
  );
}

type LicenseNoticeProps = StaticScreenProps<{ readonly entryKey: string }>;

/** One package's license: name, version, license and platforms, its source, then the notice. */
export function SettingsOpenSourceLicenseRouteScreen({ route }: LicenseNoticeProps) {
  const linkColor = useThemeColor("--color-accent");
  const manifest = loadMobileThirdPartyLicenses();
  const entry = manifest
    ? findThirdPartyLicenseEntry(manifest.entries, route.params.entryKey)
    : undefined;

  if (!entry) {
    return (
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title="License unavailable"
          detail="This build does not include that license notice."
        />
      </View>
    );
  }

  const sourceUrl = entry.sourceUrl;
  const facts = [entry.version, entry.license, formatLicenseBundles(entry.bundles)].filter(
    (fact): fact is string => fact !== null && fact.length > 0,
  );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 12, paddingBottom: 40 }}
    >
      <View className="gap-1.5 px-6">
        <Text selectable className="font-ryco-bold text-2xl text-foreground">
          {entry.name}
        </Text>
        <Text className="font-sans text-[15px] leading-5 text-foreground-muted">
          {facts.join(" · ")}
        </Text>
        {sourceUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityHint="Opens the project's website"
            onPress={() => openWebLink(sourceUrl)}
            className="min-h-11 flex-row items-center gap-1.5 self-start active:opacity-60"
          >
            <Text className="font-ryco-medium text-[15px] text-accent">Project source</Text>
            <SymbolView
              name="arrow.up.right"
              size={13}
              weight="semibold"
              tintColor={linkColor as string}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      <View className="mx-4 mt-4 rounded-[22px] bg-card p-4">
        <Text selectable className="font-mono text-[13px] leading-[19px] text-foreground">
          {entry.noticeText}
        </Text>
      </View>
    </ScrollView>
  );
}
