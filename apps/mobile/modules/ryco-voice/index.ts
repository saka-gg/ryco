import { requireOptionalNativeModule } from "expo-modules-core";
export default requireOptionalNativeModule<{
  addListener(event: "interrupted", listener: (event: { id: string }) => void): { remove(): void };
  permission(): Promise<boolean>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<string>;
  cancel(id: string): Promise<void>;
}>("RycoVoice");
