#import "CoreSimulatorVersion.h"

/// The first CoreSimulator (Xcode 27) whose guests drop legacy Indigo input.
static NSString *const kRycoFirstDTUHIDCoreSimulatorVersion = @"1155.4";

/// Diagnostic override for the transport choice; see RycoPreferredInputTransport.
static const char *const kRycoInputTransportOverrideEnv = "RYCO_DEVICE_HELPER_INPUT_TRANSPORT";

NSString *RycoCoreSimulatorVersion(void) {
  // The bundle is registered once CoreSimulator has been dlopen'd; the
  // Info.plist on disk answers the same question before that.
  NSBundle *bundle = [NSBundle bundleWithIdentifier:@"com.apple.CoreSimulator"];
  NSString *version = bundle.infoDictionary[@"CFBundleVersion"];
  if ([version isKindOfClass:[NSString class]] && version.length > 0) {
    return version;
  }
  NSDictionary *info = [NSDictionary
      dictionaryWithContentsOfFile:@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/"
                                   @"Versions/A/Resources/Info.plist"];
  version = info[@"CFBundleVersion"];
  return [version isKindOfClass:[NSString class]] && version.length > 0 ? version : nil;
}

static BOOL RycoVersionDropsIndigoInput(NSString *_Nullable version) {
  if (version == nil) {
    return NO;
  }
  // Numeric so 1155.10 sorts above 1155.4.
  return [version compare:kRycoFirstDTUHIDCoreSimulatorVersion options:NSNumericSearch] !=
         NSOrderedAscending;
}

RycoInputTransport RycoPreferredInputTransport(void) {
  const char *override = getenv(kRycoInputTransportOverrideEnv);
  if (override != NULL) {
    if (strcmp(override, "indigo") == 0) {
      return RycoInputTransportIndigo;
    }
    if (strcmp(override, "dtuhid") == 0) {
      return RycoInputTransportDtuhid;
    }
  }
  return RycoVersionDropsIndigoInput(RycoCoreSimulatorVersion()) ? RycoInputTransportDtuhid
                                                                 : RycoInputTransportIndigo;
}

NSString *RycoInputTransportName(RycoInputTransport transport) {
  switch (transport) {
    case RycoInputTransportDtuhid: return @"dtuhid";
    case RycoInputTransportIndigo: return @"indigo";
  }
  return @"indigo";
}
