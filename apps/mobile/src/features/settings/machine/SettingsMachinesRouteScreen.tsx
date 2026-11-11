import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { View } from "react-native";

type SettingsMachinesRouteScreenProps = StaticScreenProps<undefined>;

/**
 * `settings/machines`, kept for saved links: machines are listed in one place, the Machines
 * sheet, and each machine's settings are on its page there. This route only hands over.
 */
export function SettingsMachinesRouteScreen(_props: SettingsMachinesRouteScreenProps) {
  const navigation = useNavigation();
  useEffect(() => {
    navigation.dispatch(StackActions.replace("Connections"));
  }, [navigation]);
  return <View className="flex-1 bg-screen" />;
}
