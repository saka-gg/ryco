// ryco-sim-settings: a small tool that runs inside an iOS Simulator through
// `simctl spawn` and reads or writes the accessibility settings `simctl ui`
// does not cover.
//
// It calls the same libAccessibility and MediaAccessibility setters the
// Settings app uses. They write the preference and post the Darwin
// notification, so running apps update live. Liquid Glass is a UIKit
// preference plus its notification. The approach follows serve-sim's
// sim-ax-settings (Apache-2.0); see THIRD_PARTY_NOTICES.md.
//
// Every symbol is resolved with dlsym, so a runtime that lacks one reports it
// as unsupported instead of failing to launch.
//
// Usage:
//   ryco-sim-settings status          one JSON object with every key
//   ryco-sim-settings set <key> <v>   then prints the status
//
// Keys and values:
//   reduce-motion, reduce-transparency, show-borders, voiceover   on | off
//   color-filter   none | grayscale | red-green | green-red | blue-yellow
//   liquid-glass   clear | tinted

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <notify.h>
#include <stdio.h>
#include <string.h>

typedef unsigned char (*GetBool)(void);
typedef void (*SetBool)(unsigned char);
typedef long (*GetFilterType)(long);
typedef void (*SetFilterType)(long, long);
typedef unsigned char (*GetFilterEnabled)(long);
typedef void (*SetFilterEnabled)(long, unsigned char);

// The "color" category of MADisplayFilterPref*: Settings > Color Filters.
static const long kColorCategory = 1;

static void *accessibility(void) {
  static void *handle;
  if (!handle) handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW);
  return handle;
}

static void *mediaAccessibility(void) {
  static void *handle;
  if (!handle) {
    handle = dlopen("/System/Library/Frameworks/MediaAccessibility.framework/MediaAccessibility",
                    RTLD_NOW);
  }
  return handle;
}

static void *symbol(void *handle, const char *name) { return handle ? dlsym(handle, name) : NULL; }

struct Toggle {
  const char *key;
  const char *getter;
  const char *setter;
};

static const struct Toggle kToggles[] = {
    {"reduce-motion", "_AXSReduceMotionEnabled", "_AXSSetReduceMotionEnabled"},
    {"reduce-transparency", "_AXSEnhanceBackgroundContrastEnabled",
     "_AXSSetEnhanceBackgroundContrastEnabled"},
    {"show-borders", "_AXSButtonShapesEnabled", "_AXSSetButtonShapesEnabled"},
    {"voiceover", "_AXSVoiceOverTouchEnabled", "_AXSVoiceOverTouchSetEnabled"},
};
static const size_t kToggleCount = sizeof(kToggles) / sizeof(kToggles[0]);

struct Filter {
  const char *name;
  long type;
};

// MADisplayFilterType values.
static const struct Filter kFilters[] = {
    {"grayscale", 1},
    {"red-green", 2},
    {"green-red", 4},
    {"blue-yellow", 8},
};
static const size_t kFilterCount = sizeof(kFilters) / sizeof(kFilters[0]);

static const char *colorFilter(void) {
  GetFilterType getType = (GetFilterType)symbol(mediaAccessibility(), "MADisplayFilterPrefGetType");
  GetFilterEnabled getEnabled =
      (GetFilterEnabled)symbol(mediaAccessibility(), "MADisplayFilterPrefGetCategoryEnabled");
  if (!getType || !getEnabled) return NULL;
  if (!getEnabled(kColorCategory)) return "none";
  long type = getType(kColorCategory);
  for (size_t i = 0; i < kFilterCount; i++) {
    if (kFilters[i].type == type) return kFilters[i].name;
  }
  return "none";
}

static int setColorFilter(const char *name) {
  SetFilterType setType = (SetFilterType)symbol(mediaAccessibility(), "MADisplayFilterPrefSetType");
  SetFilterEnabled setEnabled =
      (SetFilterEnabled)symbol(mediaAccessibility(), "MADisplayFilterPrefSetCategoryEnabled");
  SetBool setGrayscale = (SetBool)symbol(accessibility(), "_AXSGrayscaleSetEnabled");
  if (!setType || !setEnabled) return 2;
  long type = 0;
  for (size_t i = 0; i < kFilterCount; i++) {
    if (strcmp(kFilters[i].name, name) == 0) type = kFilters[i].type;
  }
  if (type == 0 && strcmp(name, "none") != 0) return 1;
  if (type == 0) {
    setEnabled(kColorCategory, 0);
  } else {
    setType(kColorCategory, type);
    setEnabled(kColorCategory, 1);
  }
  // Settings keeps the older grayscale flag in step with the filter.
  if (setGrayscale) setGrayscale(type == 1);
  return 0;
}

static CFStringRef kGlassDomain = CFSTR("com.apple.UIKit");
static CFStringRef kGlassKey = CFSTR("UIViewGlassLegibilitySetting");

static const char *liquidGlass(void) {
  CFPropertyListRef value =
      CFPreferencesCopyValue(kGlassKey, kGlassDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
  int tinted = 0;
  if (value) {
    if (CFGetTypeID(value) == CFNumberGetTypeID()) {
      CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &tinted);
    }
    CFRelease(value);
  }
  return tinted == 1 ? "tinted" : "clear";
}

static int setLiquidGlass(const char *name) {
  int tinted;
  if (strcmp(name, "tinted") == 0) {
    tinted = 1;
  } else if (strcmp(name, "clear") == 0) {
    tinted = 0;
  } else {
    return 1;
  }
  CFNumberRef value = CFNumberCreate(NULL, kCFNumberIntType, &tinted);
  CFPreferencesSetValue(kGlassKey, value, kGlassDomain, kCFPreferencesCurrentUser,
                        kCFPreferencesAnyHost);
  CFRelease(value);
  CFPreferencesSynchronize(kGlassDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
  notify_post("UIViewGlassLegibilityUpdateNotification");
  return 0;
}

// Unsupported keys are null, so the server can hide those controls.
static void printStatus(void) {
  printf("{");
  for (size_t i = 0; i < kToggleCount; i++) {
    GetBool get = (GetBool)symbol(accessibility(), kToggles[i].getter);
    printf("\"%s\":%s,", kToggles[i].key, get ? (get() ? "\"on\"" : "\"off\"") : "null");
  }
  const char *filter = colorFilter();
  if (filter) {
    printf("\"color-filter\":\"%s\",", filter);
  } else {
    printf("\"color-filter\":null,");
  }
  printf("\"liquid-glass\":\"%s\"}\n", liquidGlass());
}

static int setToggle(const char *key, const char *value) {
  for (size_t i = 0; i < kToggleCount; i++) {
    if (strcmp(kToggles[i].key, key) != 0) continue;
    SetBool set = (SetBool)symbol(accessibility(), kToggles[i].setter);
    if (!set) return 2;
    if (strcmp(value, "on") == 0) {
      set(1);
    } else if (strcmp(value, "off") == 0) {
      set(0);
    } else {
      return 1;
    }
    return 0;
  }
  return -1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "status") == 0) {
    printStatus();
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "set") == 0) {
    const char *key = argv[2];
    const char *value = argv[3];
    int result = setToggle(key, value);
    if (result < 0) {
      if (strcmp(key, "color-filter") == 0) {
        result = setColorFilter(value);
      } else if (strcmp(key, "liquid-glass") == 0) {
        result = setLiquidGlass(value);
      } else {
        fprintf(stderr, "ryco-sim-settings: unknown setting %s\n", key);
        return 64;
      }
    }
    if (result == 1) {
      fprintf(stderr, "ryco-sim-settings: invalid value %s for %s\n", value, key);
      return 64;
    }
    if (result == 2) {
      fprintf(stderr, "ryco-sim-settings: %s is not supported by this runtime\n", key);
      return 69;
    }
    printStatus();
    return 0;
  }
  fprintf(stderr, "usage: ryco-sim-settings status | set <key> <value>\n");
  return 64;
}
