declare module "*.css";
declare module "*.html" {
  /** Metro asset id; load it through `expo-asset`. */
  const assetModuleId: number;
  export default assetModuleId;
}
