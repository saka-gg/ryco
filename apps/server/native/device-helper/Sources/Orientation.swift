// Device orientation for a headless simulator.
//
// Adapted from serve-sim (EvanBacon/serve-sim, Apache-2.0),
// packages/serve-sim/Sources/SimNative/HIDInjector.swift `sendOrientation`;
// see THIRD_PARTY_NOTICES.md. serve-sim in turn follows idb's
// `FBSimulatorPurpleHID.orientationEvent:` (MIT).
//
// Orientation is not a HID event. Simulator.app turns the device by posting a
// GraphicsServices event (a "GSEvent") to the guest's PurpleWorkspacePort,
// which backboardd hands to the sensor pipeline exactly as a real
// accelerometer reading would. CoreSimulator's `-[SimDevice lookup:error:]`
// resolves that port inside the guest's bootstrap namespace, and it is wired on
// a headless boot too: Simulator.app does not need to be running.
//
// The framebuffer does not rotate. The guest keeps drawing into the same
// portrait surface, with the interface turned inside it, so frames, touch
// coordinates and the accessibility tree all stay in portrait device space.
// The viewer turns the whole device (chassis and screen) instead.

import Darwin
import Foundation

/// The values GraphicsServices accepts, as `UIInterfaceOrientation` numbers.
/// Ryco's names say which way the device was turned, like Simulator.app's
/// Rotate Left (⌘←) and Rotate Right (⌘→).
enum DeviceOrientation: String, CaseIterable {
  case portrait
  case portraitUpsideDown = "portrait-upside-down"
  /// Turned counterclockwise: the home indicator ends up on the right.
  case landscapeLeft = "landscape-left"
  /// Turned clockwise: the home indicator ends up on the left.
  case landscapeRight = "landscape-right"

  var graphicsServicesValue: UInt32 {
    switch self {
    case .portrait: return 1
    case .portraitUpsideDown: return 2
    case .landscapeLeft: return 3
    case .landscapeRight: return 4
    }
  }
}

/// GSEvent wire format, reverse-engineered by idb from Simulator.app (see idb's
/// SimulatorApp/GSEvent.h): the event type sits at 0x18, the record size at
/// 0x48 and the 4-byte orientation payload at 0x4C.
private let gsEventTypeDeviceOrientationChanged: UInt32 = 50
private let gsEventHostFlag: UInt32 = 0x20000
private let gsEventMachMessageID: mach_msg_id_t = 0x7B
/// align4(4 + 0x6B), the message size for a GSEvent with a 4-byte payload.
private let gsEventMessageSize: mach_msg_size_t = 108

/// Turns `device` to `orientation`. Throws when the port cannot be resolved or
/// the message cannot be sent; nothing reaches the guest in either case.
func sendDeviceOrientation(_ orientation: DeviceOrientation, to device: SimulatorDevice) throws {
  let handle = device.handle
  let selector = NSSelectorFromString("lookup:error:")
  typealias LookupFn = @convention(c) (
    AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
  ) -> mach_port_t
  guard let cls = object_getClass(handle),
    let imp = class_getMethodImplementation(cls, selector),
    handle.responds(to: selector)
  else {
    throw RPCError(.simulatorFailure, "this CoreSimulator cannot look up guest ports")
  }
  var lookupError: NSError?
  let port = withUnsafeMutablePointer(to: &lookupError) { pointer in
    unsafeBitCast(imp, to: LookupFn.self)(
      handle, selector, "PurpleWorkspacePort" as NSString,
      AutoreleasingUnsafeMutablePointer(pointer))
  }
  guard port != MACH_PORT_NULL else {
    throw RPCError(
      .simulatorFailure,
      "the simulator has no orientation port yet"
        + (lookupError.map { " (\($0.localizedDescription))" } ?? ""))
  }

  // The lookup hands this process a send right; the message copies it.
  defer { mach_port_deallocate(mach_task_self_, port) }

  var buffer = [UInt8](repeating: 0, count: 112)
  let result = buffer.withUnsafeMutableBytes { raw -> kern_return_t in
    let base = raw.baseAddress!
    let header = base.assumingMemoryBound(to: mach_msg_header_t.self)
    header.pointee.msgh_bits = mach_msg_bits_t(MACH_MSG_TYPE_COPY_SEND)
    header.pointee.msgh_size = gsEventMessageSize
    header.pointee.msgh_remote_port = port
    header.pointee.msgh_local_port = mach_port_t(MACH_PORT_NULL)
    header.pointee.msgh_voucher_port = mach_port_t(MACH_PORT_NULL)
    header.pointee.msgh_id = gsEventMachMessageID
    base.storeBytes(
      of: gsEventTypeDeviceOrientationChanged | gsEventHostFlag, toByteOffset: 0x18,
      as: UInt32.self)
    base.storeBytes(of: UInt32(4), toByteOffset: 0x48, as: UInt32.self)
    base.storeBytes(of: orientation.graphicsServicesValue, toByteOffset: 0x4C, as: UInt32.self)
    return mach_msg_send(header)
  }
  guard result == KERN_SUCCESS else {
    throw RPCError(.simulatorFailure, "the orientation event was not sent (mach error \(result))")
  }
}
