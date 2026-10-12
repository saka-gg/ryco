// `@tabler/icons-react-native` publishes a `./*` export for every icon, but its
// `types` targets point at files the package does not ship. Deep imports are the
// only way to avoid the root barrel (see ./icons.ts), so type them here.
declare module "@tabler/icons-react-native/*" {
  import type { Icon } from "@tabler/icons-react-native";

  const icon: Icon;
  export default icon;
}
