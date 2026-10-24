#import "CoreSimulatorVersion.h"

NSString *const RycoFirstDTUHIDCoreSimulatorVersion = @"1155.4";

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
  return [version compare:RycoFirstDTUHIDCoreSimulatorVersion options:NSNumericSearch] !=
         NSOrderedAscending;
}

BOOL RycoCoreSimulatorDropsIndigoInput(void) {
  return RycoVersionDropsIndigoInput(RycoCoreSimulatorVersion());
}

NSString *RycoIndigoInputUnsupportedReason(void) {
  NSString *version = RycoCoreSimulatorVersion();
  if (!RycoVersionDropsIndigoInput(version)) {
    return nil;
  }
  return [NSString
      stringWithFormat:@"Simulator input on CoreSimulator %@ (Xcode 27 or later) goes through the "
                       @"guest's dtuhidd service, which this helper does not support yet; "
                       @"streaming, screenshots and the accessibility tree still work",
                       version];
}
