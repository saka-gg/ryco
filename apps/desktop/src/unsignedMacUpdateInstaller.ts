export type MacCodeSignatureKind =
  | "developer-id"
  | "apple-distribution"
  | "ad-hoc"
  | "unsigned"
  | "other-signed"
  | "unknown";

export interface UnsignedMacUpdateInstallerDecisionInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly signatureKind: MacCodeSignatureKind;
  readonly disabledByEnv: boolean;
  readonly forcedByEnv: boolean;
}

export interface UnsignedMacUpdateInstallScriptInput {
  readonly appLabel: string;
  /**
   * The running app's bundle id. A downloaded bundle with another id (Ryco Nightly
   * offered to Ryco, or the reverse) is refused instead of replacing this app.
   */
  readonly expectedBundleId: string;
  readonly updateZipPath: string;
  readonly targetAppPath: string;
  readonly waitPid: number;
  readonly logPath: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseMacCodeSignatureKind(input: {
  readonly exitCode: number | null;
  readonly output: string;
}): MacCodeSignatureKind {
  const output = input.output;
  if (/^Authority=Developer ID Application:/m.test(output)) {
    return "developer-id";
  }
  if (/^Authority=Apple Distribution:/m.test(output)) {
    return "apple-distribution";
  }
  if (/^Signature=adhoc$/m.test(output)) {
    return "ad-hoc";
  }
  if (
    input.exitCode !== 0 &&
    /code object is not signed|is not signed at all|no signature/i.test(output)
  ) {
    return "unsigned";
  }
  if (input.exitCode === 0) {
    return "other-signed";
  }
  return "unknown";
}

export function shouldUseUnsignedMacUpdateInstaller(
  input: UnsignedMacUpdateInstallerDecisionInput,
): boolean {
  if (input.platform !== "darwin" || !input.isPackaged) {
    return false;
  }
  if (input.disabledByEnv) {
    return false;
  }
  if (input.forcedByEnv) {
    return true;
  }
  return input.signatureKind !== "developer-id" && input.signatureKind !== "apple-distribution";
}

export function resolveMacAppBundlePath(execPath: string): string | null {
  const parts = execPath.split("/");
  const appIndex = parts.findLastIndex((part) => part.endsWith(".app"));
  if (appIndex === -1) {
    return null;
  }
  const bundlePath = parts.slice(0, appIndex + 1).join("/");
  return bundlePath.length > 0 ? bundlePath : null;
}

export function resolveMacUpdateTargetAppPath(currentAppBundlePath: string): string {
  const appBundleName = currentAppBundlePath.split("/").at(-1);
  return `/Applications/${appBundleName && appBundleName.length > 0 ? appBundleName : "Ryco.app"}`;
}

export function createUnsignedMacUpdateInstallScript(
  input: UnsignedMacUpdateInstallScriptInput,
): string {
  return `#!/bin/zsh
set -euo pipefail

APP_LABEL=${shellSingleQuote(input.appLabel)}
UPDATE_ZIP=${shellSingleQuote(input.updateZipPath)}
TARGET_APP=${shellSingleQuote(input.targetAppPath)}
WAIT_PID=${input.waitPid}
LOG_PATH=${shellSingleQuote(input.logPath)}
EXPECTED_BUNDLE_ID=${shellSingleQuote(input.expectedBundleId)}

/bin/mkdir -p "$(/usr/bin/dirname "$LOG_PATH")"
exec >> "$LOG_PATH" 2>&1

echo "[$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting unsigned macOS update install for $APP_LABEL"
echo "Update zip: $UPDATE_ZIP"
echo "Target app: $TARGET_APP"

for attempt in {1..120}; do
  if ! /bin/kill -0 "$WAIT_PID" 2>/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 120 ]]; then
    echo "Timed out waiting for Ryco process $WAIT_PID to exit."
    exit 1
  fi
  /bin/sleep 0.5
done

STAGING_DIR="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/ryco-update.XXXXXX")"
cleanup() {
  /bin/rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

echo "Extracting update..."
/usr/bin/ditto -x -k "$UPDATE_ZIP" "$STAGING_DIR"

SOURCE_APP="$(/usr/bin/find "$STAGING_DIR" -maxdepth 2 -name "*.app" -type d -print -quit)"
if [[ -z "$SOURCE_APP" ]]; then
  echo "Downloaded update did not contain an app bundle."
  exit 1
fi

SOURCE_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)"
if [[ "$SOURCE_BUNDLE_ID" != "$EXPECTED_BUNDLE_ID" ]]; then
  echo "Downloaded update is $SOURCE_BUNDLE_ID, not $EXPECTED_BUNDLE_ID: refusing to replace this app with another one."
  exit 1
fi

TARGET_PARENT="$(/usr/bin/dirname "$TARGET_APP")"
TARGET_NAME="$(/usr/bin/basename "$TARGET_APP")"
TEMP_TARGET="$TARGET_PARENT/.$TARGET_NAME.updating.$$"
BACKUP_TARGET="$TARGET_PARENT/.$TARGET_NAME.previous.$$"

/bin/rm -rf "$TEMP_TARGET" "$BACKUP_TARGET"

echo "Copying app bundle..."
/usr/bin/ditto "$SOURCE_APP" "$TEMP_TARGET"

echo "Removing quarantine flag..."
/usr/bin/xattr -dr com.apple.quarantine "$TEMP_TARGET" || true

if [[ -d "$TARGET_APP" ]]; then
  /bin/mv "$TARGET_APP" "$BACKUP_TARGET"
fi

if /bin/mv "$TEMP_TARGET" "$TARGET_APP"; then
  /bin/rm -rf "$BACKUP_TARGET"
else
  echo "Failed to move updated app into place."
  if [[ -d "$BACKUP_TARGET" && ! -d "$TARGET_APP" ]]; then
    /bin/mv "$BACKUP_TARGET" "$TARGET_APP"
  fi
  exit 1
fi

echo "Opening updated app..."
/usr/bin/open "$TARGET_APP"

echo "Unsigned macOS update install finished."
`;
}
