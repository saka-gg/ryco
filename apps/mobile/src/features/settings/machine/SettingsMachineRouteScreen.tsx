import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { View } from "react-native";

type SettingsMachineRouteScreenProps = StaticScreenProps<{ readonly environmentId: string }>;

/**
 * `settings/machines/:environmentId`, kept for saved links: one machine's settings
 * (Providers, Agents, Work, System, Import) are on its page in the Machines sheet, next to
 * its connection, access and appearance. This route opens that page.
 */
export function SettingsMachineRouteScreen(props: SettingsMachineRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = props.route.params.environmentId;
  useEffect(() => {
    navigation.dispatch(StackActions.replace("Connections", { environmentId }));
  }, [environmentId, navigation]);
  return <View className="flex-1 bg-screen" />;
}
