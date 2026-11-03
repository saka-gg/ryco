// Offline input-delivery regression for the HID bridge and the dtuhidd
// transport: a stub transport stands in for dtuhidd and a stub device for the
// SimDevice, so no simulator or private framework is loaded. Adapted from
// Synara (Emanuele-web04/synara#1924, commit 74e0b3654, MIT).
//
// Build and run (apps/server/src/device/nativeInputDelivery.test.ts does this):
//
//   xcrun clang -fobjc-arc -fmodules -framework Foundation -framework CoreGraphics \
//     Sources/CoreSimulatorVersion.m Sources/DTUHIDTransport.m Sources/HIDBridge.m \
//     Tests/InputDeliveryTests.m -o /tmp/ryco-input-delivery-tests
//   /tmp/ryco-input-delivery-tests
#import <Foundation/Foundation.h>

#import "../Sources/HIDBridge.h"

/// Answers like RycoDTUHIDTransport. The connection drops once `dropAfter`
/// events were sent (-1: never); from then on sends fail, as they do on a
/// dropped connection. A readiness check on a dropped connection reconnects
/// when `reconnects` is set (a respawned daemon) and otherwise reports that
/// dtuhidd is still starting. The first `failReadyChecks` readiness checks
/// report still starting regardless (a cold boot), each after `readyDelay`.
@interface StubTransport : NSObject
@property(nonatomic) NSInteger sent;
@property(nonatomic) NSInteger dropAfter;
@property(nonatomic) BOOL reconnects;
@property(nonatomic) NSInteger failReadyChecks;
@property(nonatomic) NSTimeInterval readyDelay;
@property(nonatomic) NSInteger readyChecks;
@property(nonatomic) NSInteger reconnections;
@property(nonatomic) BOOL dropped;
@property(nonatomic) BOOL droppedOnce;
@property(nonatomic) NSMutableArray<NSDictionary *> *events;
- (void)reset;
@end

static NSError *StillStarting(void) {
  return [NSError errorWithDomain:@"test"
                             code:6
                         userInfo:@{NSLocalizedDescriptionKey: @"still starting; nothing was sent"}];
}

@implementation StubTransport
- (instancetype)init {
  self = [super init];
  if (self) [self reset];
  return self;
}
- (void)reset {
  _sent = 0;
  _dropAfter = -1;
  _reconnects = NO;
  _failReadyChecks = 0;
  _readyDelay = 0;
  _readyChecks = 0;
  _reconnections = 0;
  _dropped = NO;
  _droppedOnce = NO;
  _events = [NSMutableArray new];
}
- (void)dropIfDue {
  if (_dropAfter >= 0 && _sent >= _dropAfter && !_droppedOnce) {
    _dropped = YES;
    _droppedOnce = YES;
  }
}
- (BOOL)waitUntilReadyWithTimeout:(NSTimeInterval)timeout error:(NSError **)error {
  _readyChecks++;
  if (_readyDelay > 0) usleep((useconds_t)(_readyDelay * 1000000));
  [self dropIfDue];
  if (_failReadyChecks > 0) {
    _failReadyChecks--;
    if (error) *error = StillStarting();
    return NO;
  }
  if (_dropped) {
    if (!_reconnects) {
      if (error) *error = StillStarting();
      return NO;
    }
    _dropped = NO;
    _reconnections++;
  }
  return YES;
}
- (BOOL)record:(NSDictionary *)event {
  [self dropIfDue];
  if (_dropped) return NO;
  _sent++;
  [_events addObject:event];
  return YES;
}
- (BOOL)sendKeyUsage:(uint32_t)usage down:(BOOL)down {
  return [self record:@{@"kind": @"key", @"usage": @(usage), @"down": @(down)}];
}
- (BOOL)sendTouchAtX:(double)x y:(double)y down:(BOOL)down edge:(RycoTouchEdge)edge {
  return [self record:@{@"kind": @"touch", @"down": @(down)}];
}
- (BOOL)sendConsumerUsage:(uint16_t)usage down:(BOOL)down {
  return [self record:@{@"kind": @"button", @"usage": @(usage), @"down": @(down)}];
}
- (BOOL)flushWithTimeout:(NSTimeInterval)timeout {
  return !_dropped;
}
- (void)invalidate {
}
@end

/// A SimDevice that cannot look up guest services, counting how often the
/// transport asks: each connection attempt asks once.
@interface NoLookupDevice : NSObject
@property(atomic) NSInteger lookupQueries;
@end

@implementation NoLookupDevice
- (BOOL)respondsToSelector:(SEL)selector {
  if (selector == NSSelectorFromString(@"lookup:error:")) {
    self.lookupQueries += 1;
    return NO;
  }
  return [super respondsToSelector:selector];
}
@end

static int gFailures = 0;

/// Not NSCAssert: a build with NS_BLOCK_ASSERTIONS must not pass silently.
static void Expect(BOOL condition, NSString *message) {
  if (!condition) {
    gFailures++;
    fprintf(stderr, "FAIL: %s\n", message.UTF8String);
  }
}

static void TestBridge(void) {
  RycoHIDBridge *bridge = [RycoHIDBridge new];
  Expect([bridge.transportName isEqualToString:@"indigo"],
         @"A bridge without a dtuhidd transport did not report indigo");

  StubTransport *transport = [StubTransport new];
  [bridge setValue:transport forKey:@"dtuhid"];
  Expect([bridge.transportName isEqualToString:@"dtuhid"],
         @"A bridge with a dtuhidd transport did not report dtuhid");

  // The connection drops after two events: "a" went out, "b" did not.
  transport.dropAfter = 2;
  [bridge beginInput];
  [bridge typeText:@"abc"];
  Expect(transport.sent == 2, @"Input continued after the connection dropped");
  Expect([bridge.undeliveredReason containsString:@"partially delivered"],
         @"A delivered prefix was advertised as wholly unsent");
  Expect(![bridge.undeliveredReason containsString:@"nothing was sent"],
         @"Partial input is replayable by the server");

  // Nothing goes out at all.
  [transport reset];
  transport.failReadyChecks = 1;
  [bridge beginInput];
  [bridge typeText:@"abc"];
  Expect(transport.sent == 0, @"Unready input was sent");
  Expect([bridge.undeliveredReason hasPrefix:@"nothing was sent:"],
         @"Wholly refused input lost its delivery evidence");

  // Holds and gestures that cannot finish inside the 13 s budget never start,
  // and are refused before waiting for dtuhidd.
  [transport reset];
  [bridge beginInput];
  [bridge tapAtX:0.5 y:0.5 holdMs:14000];
  Expect(transport.sent == 0, @"Over-budget long press started a contact");
  Expect(transport.readyChecks == 0, @"Over-budget long press waited for dtuhidd first");
  Expect([bridge.undeliveredReason hasPrefix:@"nothing was sent:"],
         @"A refused long press was not reported as unsent");
  [bridge beginInput];
  [bridge dragFromX:0.1 y:0.1 toX:0.9 endY:0.9 durationMs:12000];
  Expect(transport.sent == 0, @"Over-budget drag started a contact");
  Expect([bridge.undeliveredReason containsString:@"input deadline"],
         @"An over-budget drag was not refused for the deadline");

  // A drag that fits the budget, when the warm-up wait leaves too little of
  // it: reported as dtuhidd still starting (the server retries that), not as
  // a gesture too long for the deadline (which it never retries).
  [transport reset];
  transport.readyDelay = 1.0;
  [bridge beginInput];
  [bridge dragFromX:0.1 y:0.1 toX:0.9 endY:0.9 durationMs:10500];
  Expect(transport.sent == 0, @"A drag cut short by the warm-up started a contact");
  Expect([bridge.undeliveredReason hasPrefix:@"nothing was sent:"] &&
             [bridge.undeliveredReason containsString:@"still starting"],
         @"A drag cut short by the warm-up was not reported as still starting");
  Expect(![bridge.undeliveredReason containsString:@"input deadline"],
         @"A drag cut short by the warm-up was blamed on its own length");

  // "A" is Shift + a. The key-up of "a" fails on a dropped connection, so the
  // bridge must release the character and Shift, and type nothing more.
  [transport reset];
  transport.dropAfter = 2;
  transport.reconnects = YES;
  [bridge beginInput];
  [bridge typeText:@"Ab"];
  Expect(transport.events.count == 4,
         @"Cleanup did not release the character and Shift, or kept typing");
  if (transport.events.count == 4) {
    Expect([transport.events[2][@"down"] isEqual:@NO] &&
               [transport.events[3][@"down"] isEqual:@NO],
           @"Cleanup queued another key-down");
    Expect([transport.events[3][@"usage"] isEqual:@0xe1], @"Shift was left pressed");
  }
  Expect([bridge.undeliveredReason containsString:@"partially delivered"],
         @"A text cut short by a dropped connection was not reported as partial");

  // The connection drops while a tap is held. The touch-up must not go out on
  // a fresh connection whose daemon never saw the touch-down, acking a tap
  // that may never have landed.
  [transport reset];
  transport.dropAfter = 1;
  transport.reconnects = YES;
  NSInteger dropped = bridge.undeliveredEventCount;
  [bridge beginInput];
  [bridge tapAtX:0.5 y:0.5 holdMs:10];
  Expect(transport.reconnections == 0, @"A tap reconnected part-way through");
  Expect(transport.sent == 1, @"A tap sent its touch-up on another connection");
  Expect(bridge.undeliveredEventCount > dropped,
         @"A tap whose touch-up was lost reported success");
  Expect([bridge.undeliveredReason containsString:@"partially delivered"],
         @"A tap whose touch-up was lost was not reported as partial");

  // A button or key press while dtuhidd is still starting sends nothing, and
  // does not wait a second time to send a release for it.
  [transport reset];
  transport.failReadyChecks = 1;
  [bridge beginInput];
  [bridge tapButton:RycoHardwareButtonHome];
  Expect(transport.events.count == 0, @"A failed button press still sent its release");
  Expect(transport.readyChecks == 1, @"A failed button press waited again for its release");
  Expect([bridge.undeliveredReason hasPrefix:@"nothing was sent:"],
         @"A failed button press was not reported as unsent");

  [transport reset];
  transport.failReadyChecks = 1;
  [bridge beginInput];
  [bridge tapKeyUsage:4];
  Expect(transport.events.count == 0, @"A failed key press still sent its key-up");
  Expect(transport.readyChecks == 1, @"A failed key press waited again for its key-up");
  Expect([bridge.undeliveredReason hasPrefix:@"nothing was sent:"],
         @"A failed key press was not reported as unsent");

  // The happy path still presses and releases.
  [transport reset];
  [bridge beginInput];
  [bridge tapButton:RycoHardwareButtonHome];
  Expect(transport.events.count == 2, @"A button tap did not press and release");
}

/// After a whole warm-up failed, inputs fail at once with its cause rather
/// than each starting another round of attempts.
static void TestTransportAfterFailedWarmUp(void) {
  NoLookupDevice *device = [NoLookupDevice new];
  RycoDTUHIDTransport *transport = [[RycoDTUHIDTransport alloc] initWithDevice:device];
  // The warm-up's one attempt (the lookup selector is missing, which is not
  // retried) finishes almost at once.
  for (int i = 0; i < 200 && device.lookupQueries == 0; i++) usleep(10000);
  if (device.lookupQueries == 0) {
    // This macOS lacks the _4sim symbols, so the device is never asked.
    puts("Skipped the failed warm-up check: no _4sim XPC symbols here");
    [transport invalidate];
    return;
  }
  usleep(50000);
  NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
  NSError *first = nil;
  NSError *second = nil;
  BOOL firstReady = [transport waitUntilReadyWithTimeout:2 error:&first];
  BOOL secondReady = [transport waitUntilReadyWithTimeout:2 error:&second];
  NSTimeInterval elapsed = NSProcessInfo.processInfo.systemUptime - started;
  Expect(!firstReady && !secondReady, @"A transport without a service reported ready");
  Expect(device.lookupQueries == 1, @"Each input started another round after a failed warm-up");
  Expect(elapsed < 1.0, @"An input waited after the warm-up had already failed");
  Expect([first.localizedDescription containsString:@"cannot look up guest services"] &&
             [second.localizedDescription containsString:@"cannot look up guest services"],
         @"An input after a failed warm-up did not report its cause");
  [transport invalidate];
}

int main(void) {
  @autoreleasepool {
    TestBridge();
    TestTransportAfterFailedWarmUp();
    if (gFailures > 0) {
      fprintf(stderr, "%d input delivery check(s) failed\n", gFailures);
      return 1;
    }
    puts("Input delivery, deadline and held-key cleanup regressions passed");
  }
  return 0;
}
