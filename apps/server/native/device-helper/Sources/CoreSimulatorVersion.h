// CoreSimulator version gate shared by the HID bridge and the capability probe.
//
// CoreSimulator is system-wide (/Library/Developer/PrivateFrameworks) and is
// installed by the newest Xcode on the machine, so its version, not the
// selected Xcode's, decides how simulator input has to travel. From 1155.4
// (Xcode 27) the guest drops legacy Indigo button and keyboard events and
// delivers Indigo touches unreliably while the host-side send still succeeds.
// That is exactly the silent acked no-op the helper is built to refuse, so the
// gate lives in one place and every caller asks it.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The loaded CoreSimulator's CFBundleVersion, or nil when it cannot be read.
NSString *_Nullable RycoCoreSimulatorVersion(void);

/// Why Indigo input is refused on this host, or nil when Indigo is usable.
/// Decided by version alone: the guest's `dtuhidd` is demand-launched, so
/// whether it happens to be running says nothing. nil when the version cannot
/// be read. Goes away once the helper delivers input through `dtuhidd`.
NSString *_Nullable RycoIndigoInputUnsupportedReason(void);

NS_ASSUME_NONNULL_END
