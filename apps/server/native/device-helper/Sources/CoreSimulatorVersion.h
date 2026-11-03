// CoreSimulator version gate shared by the HID bridge and the capability probe.
//
// CoreSimulator is system-wide (/Library/Developer/PrivateFrameworks) and is
// installed by the newest Xcode on the machine, so its version, not the
// selected Xcode's, decides how simulator input has to travel. From 1155.4
// (Xcode 27) the guest drops legacy Indigo button and keyboard events and
// delivers Indigo touches unreliably while the host-side send still succeeds,
// so input goes through the guest's `dtuhidd` instead (DTUHIDTransport.h).
// The choice lives here, in one place, and every caller asks it.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The two ways the helper can deliver HID input.
typedef NS_ENUM(NSInteger, RycoInputTransport) {
  /// SimulatorKit's Indigo messages through `SimDeviceLegacyHIDClient`.
  RycoInputTransportIndigo,
  /// XPC dictionaries to the guest's `dtuhidd` (DTUHIDTransport).
  RycoInputTransportDtuhid,
};

/// The loaded CoreSimulator's CFBundleVersion, or nil when it cannot be read.
NSString *_Nullable RycoCoreSimulatorVersion(void);

/// `dtuhid` on CoreSimulator 1155.4 and later, `indigo` before (and when the
/// version cannot be read). Decided by version alone: `dtuhidd` is
/// demand-launched, so whether it happens to be running says nothing.
///
/// `RYCO_DEVICE_HELPER_INPUT_TRANSPORT=indigo|dtuhid` overrides the rule, for
/// diagnosis only (qualifying a runtime on the other transport); any other
/// value is ignored. There is no automatic fallback to Indigo: on 1155.4+ its
/// sends are acked and dropped.
RycoInputTransport RycoPreferredInputTransport(void);

/// `@"indigo"` or `@"dtuhid"`, as reported by `--probe` and `attach`.
NSString *RycoInputTransportName(RycoInputTransport transport);

NS_ASSUME_NONNULL_END
