#import "HIDBridge.h"

#import "CoreSimulatorVersion.h"

#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>

#pragma pack(push, 4)

// Mirrors the mach_msg_header_t prefix Indigo messages carry.
typedef struct {
  unsigned int msgh_bits;
  unsigned int msgh_size;
  unsigned int msgh_remote_port;
  unsigned int msgh_local_port;
  unsigned int msgh_voucher_port;
  unsigned int msgh_id;
} RycoIndigoMachHeader;

typedef struct {
  unsigned int field1;
  unsigned int field2;
  unsigned int field3;
  double xRatio;
  double yRatio;
  double field6;
  double field7;
  double field8;
  unsigned int field9;
  unsigned int field10;
  unsigned int field11;
  unsigned int field12;
  unsigned int field13;
  double field14;
  double field15;
  double field16;
  double field17;
  double field18;
} RycoIndigoTouch;

typedef struct {
  unsigned int eventSource;
  unsigned int eventType;
  unsigned int eventTarget;
  unsigned int keyCode;
  unsigned int field5;
} RycoIndigoButton;

typedef union {
  RycoIndigoTouch touch;
  RycoIndigoButton button;
  unsigned char raw[144];
} RycoIndigoEvent;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  RycoIndigoEvent event;
} RycoIndigoPayload;

typedef struct {
  RycoIndigoMachHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  RycoIndigoPayload payload;
} RycoIndigoMessage;

#pragma pack(pop)

static const unsigned char kIndigoEventTypeTouch = 2;

static const int kButtonSourceHome = 0x0;
static const int kButtonSourceLock = 0x1;
static const int kButtonSourceSide = 0xbb8;
static const int kButtonSourceSiri = 0x400002;

// Volume is not a button. Indigo's button sources are a sparse enum with no
// volume member; the guest receives volume as a HID Consumer-page event, which
// is how Simulator.app's own Increase/Decrease Volume menu items send it. Only
// the button-shaped controls above go through IndigoHIDMessageForButton.
static const uint32_t kHIDPageConsumer = 0x0c;
static const uint32_t kHIDUsageVolumeIncrement = 0xe9;
static const uint32_t kHIDUsageVolumeDecrement = 0xea;

static const int kButtonTargetHardware = 0x33;
static const int kButtonOpDown = 0x1;
static const int kButtonOpUp = 0x2;

// The mouse/touch seed message target, ported from idb.
static const int kTouchTarget = 0x32;

typedef RycoIndigoMessage *(*RycoIndigoButtonFn)(int keyCode, int op, int target);
typedef RycoIndigoMessage *(*RycoIndigoKeyboardFn)(uint32_t usage, int op);
typedef RycoIndigoMessage *(*RycoIndigoMouseFn)(CGPoint *point0, CGPoint *point1, int target,
                                                    int eventType, BOOL extra);
typedef RycoIndigoMessage *(*RycoIndigoArbitraryFn)(int target, uint32_t page, uint32_t usage,
                                                        int op);

BOOL RycoHardwareButtonFromName(NSString *name, RycoHardwareButton *outButton) {
  NSDictionary<NSString *, NSNumber *> *map = @{
    @"home": @(RycoHardwareButtonHome),
    @"lock": @(RycoHardwareButtonLock),
    @"side": @(RycoHardwareButtonSide),
    @"siri": @(RycoHardwareButtonSiri),
    @"volume-up": @(RycoHardwareButtonVolumeUp),
    @"volume-down": @(RycoHardwareButtonVolumeDown),
  };
  NSNumber *found = map[name.lowercaseString];
  if (found == nil) {
    return NO;
  }
  if (outButton != NULL) {
    *outButton = (RycoHardwareButton)found.integerValue;
  }
  return YES;
}

static int RycoButtonSource(RycoHardwareButton button) {
  switch (button) {
    case RycoHardwareButtonHome: return kButtonSourceHome;
    case RycoHardwareButtonLock: return kButtonSourceLock;
    case RycoHardwareButtonSide: return kButtonSourceSide;
    case RycoHardwareButtonSiri: return kButtonSourceSiri;
    case RycoHardwareButtonVolumeUp:
    case RycoHardwareButtonVolumeDown: return -1;
  }
  return kButtonSourceHome;
}

/// Consumer-page usage for the two volume keys, or 0 for the buttons that
/// travel as Indigo button events instead.
static uint32_t RycoConsumerUsage(RycoHardwareButton button) {
  switch (button) {
    case RycoHardwareButtonVolumeUp: return kHIDUsageVolumeIncrement;
    case RycoHardwareButtonVolumeDown: return kHIDUsageVolumeDecrement;
    default: return 0;
  }
}

/// USB HID usage for a printable ASCII character, plus whether shift is needed.
/// Returns 0 for characters with no mapping.
static uint32_t RycoUsageForCharacter(unichar c, BOOL *outShift) {
  BOOL shift = NO;
  uint32_t usage = 0;

  if (c >= 'a' && c <= 'z') {
    usage = 4 + (c - 'a');
  } else if (c >= 'A' && c <= 'Z') {
    usage = 4 + (c - 'A');
    shift = YES;
  } else if (c >= '1' && c <= '9') {
    usage = 30 + (c - '1');
  } else if (c == '0') {
    usage = 39;
  } else {
    switch (c) {
      case '\n': case '\r': usage = 40; break;  // Return
      case 0x1b: usage = 41; break;             // Escape
      case 0x08: case 0x7f: usage = 42; break;  // Delete
      case '\t': usage = 43; break;
      case ' ': usage = 44; break;
      case '-': usage = 45; break;
      case '_': usage = 45; shift = YES; break;
      case '=': usage = 46; break;
      case '+': usage = 46; shift = YES; break;
      case '[': usage = 47; break;
      case '{': usage = 47; shift = YES; break;
      case ']': usage = 48; break;
      case '}': usage = 48; shift = YES; break;
      case '\\': usage = 49; break;
      case '|': usage = 49; shift = YES; break;
      case ';': usage = 51; break;
      case ':': usage = 51; shift = YES; break;
      case '\'': usage = 52; break;
      case '"': usage = 52; shift = YES; break;
      case '`': usage = 53; break;
      case '~': usage = 53; shift = YES; break;
      case ',': usage = 54; break;
      case '<': usage = 54; shift = YES; break;
      case '.': usage = 55; break;
      case '>': usage = 55; shift = YES; break;
      case '/': usage = 56; break;
      case '?': usage = 56; shift = YES; break;
      case '!': usage = 30; shift = YES; break;
      case '@': usage = 31; shift = YES; break;
      case '#': usage = 32; shift = YES; break;
      case '$': usage = 33; shift = YES; break;
      case '%': usage = 34; shift = YES; break;
      case '^': usage = 35; shift = YES; break;
      case '&': usage = 36; shift = YES; break;
      case '*': usage = 37; shift = YES; break;
      case '(': usage = 38; shift = YES; break;
      case ')': usage = 39; shift = YES; break;
      default: usage = 0; break;
    }
  }

  if (outShift != NULL) {
    *outShift = shift;
  }
  return usage;
}

static const uint32_t kUsageLeftShift = 225;

// Guarded by @synchronized on the class object; see +simulatorKitPath.
static NSString *gSimulatorKitPath = nil;

@implementation RycoHIDBridge {
  id _client;
  dispatch_queue_t _sendQueue;
  RycoIndigoButtonFn _buttonFn;
  RycoIndigoKeyboardFn _keyboardFn;
  RycoIndigoMouseFn _mouseFn;
  RycoIndigoArbitraryFn _arbitraryFn;
  NSInteger _undelivered;
}

- (NSInteger)undeliveredEventCount {
  @synchronized(self) {
    return _undelivered;
  }
}

/// Record an event that never reached the guest. Every early return in the
/// injection paths below funnels through here, so no failure stays invisible.
- (void)noteUndelivered {
  @synchronized(self) {
    _undelivered += 1;
  }
}

+ (nullable NSString *)simulatorKitPath {
  @synchronized([RycoHIDBridge class]) {
    return gSimulatorKitPath;
  }
}

+ (void)setSimulatorKitPath:(nullable NSString *)simulatorKitPath {
  @synchronized([RycoHIDBridge class]) {
    gSimulatorKitPath = [simulatorKitPath copy];
  }
}

- (BOOL)attachToDevice:(id)device error:(NSError **)error {
  // Checked first: on CoreSimulator 1155.4+ every Indigo send below would
  // "succeed" while the guest drops it.
  NSString *refusal = RycoIndigoInputUnsupportedReason();
  if (refusal != nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                   code:5
                               userInfo:@{NSLocalizedDescriptionKey: refusal}];
    }
    return NO;
  }

  NSString *kitPath = RycoHIDBridge.simulatorKitPath;
  if (kitPath.length == 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey: @"SimulatorKit was not loaded"}];
    }
    return NO;
  }
  // Returns the image loadPrivateFrameworks already loaded.
  void *kit = dlopen(kitPath.fileSystemRepresentation, RTLD_NOW);
  if (kit == NULL) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey:
                                            [NSString stringWithFormat:@"cannot load SimulatorKit at %@", kitPath]}];
    }
    return NO;
  }

  _arbitraryFn = (RycoIndigoArbitraryFn)dlsym(kit, "IndigoHIDMessageForHIDArbitrary");
  _buttonFn = (RycoIndigoButtonFn)dlsym(kit, "IndigoHIDMessageForButton");
  _keyboardFn = (RycoIndigoKeyboardFn)dlsym(kit, "IndigoHIDMessageForKeyboardArbitrary");
  _mouseFn = (RycoIndigoMouseFn)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
  if (_buttonFn == NULL || _keyboardFn == NULL || _mouseFn == NULL || _arbitraryFn == NULL) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                   code:2
                               userInfo:@{NSLocalizedDescriptionKey: @"SimulatorKit Indigo symbols missing"}];
    }
    return NO;
  }

  Class clientClass = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  if (clientClass == nil) {
    clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  }
  if (clientClass == nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                   code:3
                               userInfo:@{NSLocalizedDescriptionKey: @"SimDeviceLegacyHIDClient class missing"}];
    }
    return NO;
  }

  NSError *initError = nil;
  id allocated = [clientClass alloc];
  SEL initSelector = NSSelectorFromString(@"initWithDevice:error:");
  id client = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(allocated, initSelector, device, &initError);
  if (client == nil) {
    if (error) {
      *error = initError ?: [NSError errorWithDomain:@"dev.ryco.device-helper.hid"
                                                code:4
                                            userInfo:@{NSLocalizedDescriptionKey: @"HID client init failed"}];
    }
    return NO;
  }

  _client = client;
  _sendQueue = dispatch_queue_create("dev.ryco.device-helper.hid", DISPATCH_QUEUE_SERIAL);
  return YES;
}

- (void)sendMessage:(RycoIndigoMessage *)message {
  if (_client == nil || message == NULL) {
    [self noteUndelivered];
    return;
  }
  SEL selector = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
  void (^completion)(NSError *) = ^(NSError *sendError) {
    // Errors here are per-event and non-fatal; the stream keeps going.
  };
  ((void (*)(id, SEL, RycoIndigoMessage *, BOOL, dispatch_queue_t, void (^)(NSError *)))objc_msgSend)(
      _client, selector, message, YES, _sendQueue, completion);
}

- (void)sendTouchAtX:(double)x y:(double)y down:(BOOL)down {
  if (_mouseFn == NULL) {
    [self noteUndelivered];
    return;
  }
  CGPoint point = CGPointMake(x, y);
  RycoIndigoMessage *seed = _mouseFn(&point, NULL, kTouchTarget, down ? kButtonOpDown : kButtonOpUp, NO);
  if (seed == NULL) {
    [self noteUndelivered];
    return;
  }

  // A touch is delivered as two payloads in one message; the seed only supplies
  // the first, so it is duplicated and the digitizer fields fixed up.
  size_t stride = sizeof(RycoIndigoPayload);
  RycoIndigoMessage *message = calloc(1, sizeof(RycoIndigoMessage) + stride);
  if (message == NULL) {
    free(seed);
    [self noteUndelivered];
    return;
  }
  message->innerSize = (unsigned int)stride;
  message->eventType = kIndigoEventTypeTouch;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = mach_absolute_time();

  memcpy(&message->payload.event.touch, &seed->payload.event.touch, sizeof(RycoIndigoTouch));
  message->payload.event.touch.xRatio = x;
  message->payload.event.touch.yRatio = y;

  void *first = &message->payload;
  void *second = (void *)((uintptr_t)first + stride);
  memcpy(second, first, stride);
  RycoIndigoPayload *secondPayload = (RycoIndigoPayload *)second;
  secondPayload->event.touch.field1 = 0x00000001;
  secondPayload->event.touch.field2 = 0x00000002;

  free(seed);
  [self sendMessage:message];
}

- (void)tapAtX:(double)x y:(double)y holdMs:(NSInteger)holdMs {
  [self sendTouchAtX:x y:y down:YES];
  usleep((useconds_t)(MAX(holdMs, 1) * 1000));
  [self sendTouchAtX:x y:y down:NO];
}

- (void)dragFromX:(double)startX
                y:(double)startY
              toX:(double)endX
             endY:(double)endY
       durationMs:(NSInteger)durationMs {
  NSInteger duration = MAX(durationMs, 1);
  // ~120Hz of interpolation, bounded so a long drag stays cheap.
  NSInteger steps = MIN(MAX(duration / 8, 2), 240);

  [self sendTouchAtX:startX y:startY down:YES];
  useconds_t stepDelay = (useconds_t)((duration * 1000) / steps);
  for (NSInteger step = 1; step <= steps; step++) {
    double progress = (double)step / (double)steps;
    double x = startX + (endX - startX) * progress;
    double y = startY + (endY - startY) * progress;
    usleep(stepDelay);
    // A move is a touch-down at the new point: the finger stays on screen.
    [self sendTouchAtX:x y:y down:YES];
  }
  [self sendTouchAtX:endX y:endY down:NO];
}

- (void)sendKeyUsage:(uint32_t)usage down:(BOOL)down {
  if (_keyboardFn == NULL) {
    [self noteUndelivered];
    return;
  }
  RycoIndigoMessage *message = _keyboardFn(usage, down ? kButtonOpDown : kButtonOpUp);
  [self sendMessage:message];
}

- (void)tapKeyUsage:(uint32_t)usage {
  [self sendKeyUsage:usage down:YES];
  usleep(12000);
  [self sendKeyUsage:usage down:NO];
}

- (NSInteger)typeText:(NSString *)text {
  NSInteger skipped = 0;
  NSUInteger length = text.length;
  for (NSUInteger index = 0; index < length; index++) {
    unichar character = [text characterAtIndex:index];
    BOOL needsShift = NO;
    uint32_t usage = RycoUsageForCharacter(character, &needsShift);
    if (usage == 0) {
      skipped++;
      continue;
    }
    if (needsShift) {
      [self sendKeyUsage:kUsageLeftShift down:YES];
    }
    [self tapKeyUsage:usage];
    if (needsShift) {
      [self sendKeyUsage:kUsageLeftShift down:NO];
    }
    // Paced so the guest's keyboard stack does not coalesce keystrokes.
    usleep(18000);
  }
  return skipped;
}

- (void)sendButton:(RycoHardwareButton)button down:(BOOL)down {
  int op = down ? kButtonOpDown : kButtonOpUp;
  uint32_t consumerUsage = RycoConsumerUsage(button);

  if (consumerUsage != 0) {
    if (_arbitraryFn == NULL) {
      [self noteUndelivered];
      return;
    }
    [self sendMessage:_arbitraryFn(kButtonTargetHardware, kHIDPageConsumer, consumerUsage, op)];
    return;
  }

  if (_buttonFn == NULL) {
    [self noteUndelivered];
    return;
  }
  [self sendMessage:_buttonFn(RycoButtonSource(button), op, kButtonTargetHardware)];
}

- (void)tapButton:(RycoHardwareButton)button {
  [self sendButton:button down:YES];
  usleep(90000);
  [self sendButton:button down:NO];
}

@end
