import type { ComputerUseHelperAppIdentity } from "@ryco/shared/computerUseHelperApp";

export declare const defaultComputerUseAppExecutablePath: string;

export declare function buildComputerUseAppExecutable(options?: {
  readonly arch?: string;
  readonly outputPath?: string;
  readonly release?: boolean;
  readonly quiet?: boolean;
}): string;

export interface AssembleComputerUseAppOptions {
  readonly executable: string;
  readonly outputDirectory: string;
  readonly identity: ComputerUseHelperAppIdentity;
  readonly version: string;
  readonly iconPath: string;
  readonly resourcesDirectory?: string;
  /** Unpackaged builds: the app or executable that may broker the helper. */
  readonly hostPath?: string;
  /** null leaves signing to electron-builder. */
  readonly signingIdentity?: string | null;
}

export declare function computerUseAppDigest(options: AssembleComputerUseAppOptions): string;

export declare function assembleComputerUseApp(options: AssembleComputerUseAppOptions): string;
