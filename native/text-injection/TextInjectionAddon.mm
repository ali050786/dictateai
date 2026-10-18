#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <thread>

// Strategy 1: AXUIElement — set the value attribute of the focused text field
static bool InjectViaAccessibility(const std::string& text) {
  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  AXUIElementRef focusedElement = nullptr;
  AXError err = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);
  CFRelease(systemWide);

  if (err != kAXErrorSuccess || !focusedElement) return false;

  // Check if element accepts text input
  CFTypeRef role = nullptr;
  AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &role);
  bool isTextField = false;
  if (role) {
    isTextField = CFEqual(role, kAXTextFieldRole) ||
                  CFEqual(role, kAXTextAreaRole) ||
                  CFEqual(role, kAXComboBoxRole);
    CFRelease(role);
  }

  if (!isTextField) {
    // Still try — some apps use custom roles
  }

  // Get current value and selection to append at cursor
  CFTypeRef currentValue = nullptr;
  AXUIElementCopyAttributeValue(focusedElement, kAXValueAttribute, &currentValue);

  CFTypeRef selectedRange = nullptr;
  AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextRangeAttribute, &selectedRange);

  NSString* nsText = [NSString stringWithUTF8String:text.c_str()];
  NSString* current = currentValue ? (__bridge NSString*)currentValue : @"";

  NSString* newValue;
  if (selectedRange) {
    AXValueRef rangeValue = (AXValueRef)selectedRange;
    CFRange range;
    if (AXValueGetValue(rangeValue, (AXValueType)kAXValueCFRangeType, &range)) {
      NSMutableString* mutable_ = [current mutableCopy];
      NSRange nsRange = NSMakeRange(range.location, range.length);
      if (nsRange.location + nsRange.length <= (NSUInteger)[mutable_ length]) {
        [mutable_ replaceCharactersInRange:nsRange withString:nsText];
        newValue = mutable_;
      } else {
        newValue = [current stringByAppendingString:nsText];
      }
    } else {
      newValue = [current stringByAppendingString:nsText];
    }
    CFRelease(selectedRange);
  } else {
    newValue = [current stringByAppendingString:nsText];
  }

  if (currentValue) CFRelease(currentValue);

  err = AXUIElementSetAttributeValue(
      focusedElement, kAXValueAttribute, (__bridge CFTypeRef)newValue);

  CFRelease(focusedElement);
  return err == kAXErrorSuccess;
}

// Strategy 2: CGEvent keystroke simulation — types each character
static bool InjectViaKeystrokes(const std::string& text) {
  NSString* nsText = [NSString stringWithUTF8String:text.c_str()];

  for (NSUInteger i = 0; i < [nsText length]; i++) {
    unichar ch = [nsText characterAtIndex:i];

    CGEventRef keyDown = CGEventCreateKeyboardEvent(nullptr, 0, true);
    CGEventRef keyUp = CGEventCreateKeyboardEvent(nullptr, 0, false);

    if (!keyDown || !keyUp) {
      if (keyDown) CFRelease(keyDown);
      if (keyUp) CFRelease(keyUp);
      return false;
    }

    UniChar uniChar = ch;
    CGEventKeyboardSetUnicodeString(keyDown, 1, &uniChar);
    CGEventKeyboardSetUnicodeString(keyUp, 1, &uniChar);

    CGEventPost(kCGAnnotatedSessionEventTap, keyDown);
    CGEventPost(kCGAnnotatedSessionEventTap, keyUp);

    CFRelease(keyDown);
    CFRelease(keyUp);

    // Brief pause to avoid dropped keystrokes
    usleep(1000);
  }

  return true;
}

// Strategy 3: Clipboard paste — Cmd+V
static bool InjectViaClipboard(const std::string& text) {
  NSPasteboard* pb = [NSPasteboard generalPasteboard];

  // Save current clipboard
  NSArray* oldTypes = [pb types];
  NSData* oldData = nil;
  if ([oldTypes containsObject:NSPasteboardTypeString]) {
    oldData = [pb dataForType:NSPasteboardTypeString];
  }

  // Set our text
  [pb clearContents];
  [pb setString:[NSString stringWithUTF8String:text.c_str()] forType:NSPasteboardTypeString];

  // Simulate Cmd+V
  CGEventRef keyDown = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_V, true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_V, false);

  if (!keyDown || !keyUp) {
    if (keyDown) CFRelease(keyDown);
    if (keyUp) CFRelease(keyUp);
    return false;
  }

  CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);
  CGEventPost(kCGAnnotatedSessionEventTap, keyDown);
  CGEventPost(kCGAnnotatedSessionEventTap, keyUp);
  CFRelease(keyDown);
  CFRelease(keyUp);

  // Restore clipboard after a delay
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    if (oldData) {
      [pb clearContents];
      [pb setData:oldData forType:NSPasteboardTypeString];
    }
  });

  return true;
}

// --- Push-to-talk key monitor ---

static CFMachPortRef pttEventTap = nullptr;
static CFRunLoopSourceRef pttRunLoopSource = nullptr;
static Napi::ThreadSafeFunction pttCallback;
static std::thread pttThread;
static bool pttRunning = false;
static bool pttKeyDown = false;

// Configurable PTT key — defaults to Right Option
static CGKeyCode pttKeyCode = kVK_RightOption;         // 0x3D
static CGEventFlags pttFlagMask = NX_DEVICERALTKEYMASK; // device-specific bit for modifier keys
static bool pttIsModifierKey = true;                    // true = modifier-only, false = regular key
static CGEventFlags pttRequiredModifiers = 0;           // for combos like Ctrl+Space

static CGEventRef PttEventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* refcon) {
  (void)proxy;
  (void)refcon;

  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (pttEventTap) CGEventTapEnable(pttEventTap, true);
    return event;
  }

  if (pttIsModifierKey) {
    if (type != kCGEventFlagsChanged) return event;

    CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (keyCode != pttKeyCode) return event;

    CGEventFlags flags = CGEventGetFlags(event);
    bool keyIsDown = (flags & pttFlagMask) != 0;

    if (keyIsDown && !pttKeyDown) {
      pttKeyDown = true;
      pttCallback.NonBlockingCall([](Napi::Env env, Napi::Function fn) {
        fn.Call({Napi::String::New(env, "down")});
      });
      return nullptr;
    }

    if (!keyIsDown && pttKeyDown) {
      pttKeyDown = false;
      pttCallback.NonBlockingCall([](Napi::Env env, Napi::Function fn) {
        fn.Call({Napi::String::New(env, "up")});
      });
      return nullptr;
    }
  } else {
    if (type == kCGEventKeyDown) {
      CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
      if (keyCode != pttKeyCode) return event;
      if (pttRequiredModifiers) {
        CGEventFlags flags = CGEventGetFlags(event);
        if ((flags & pttRequiredModifiers) != pttRequiredModifiers) return event;
      }
      if (!pttKeyDown) {
        pttKeyDown = true;
        pttCallback.NonBlockingCall([](Napi::Env env, Napi::Function fn) {
          fn.Call({Napi::String::New(env, "down")});
        });
        return nullptr;
      }
    } else if (type == kCGEventKeyUp) {
      CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
      if (keyCode != pttKeyCode) return event;
      if (pttKeyDown) {
        pttKeyDown = false;
        pttCallback.NonBlockingCall([](Napi::Env env, Napi::Function fn) {
          fn.Call({Napi::String::New(env, "up")});
        });
        return nullptr;
      }
    }
  }

  return event;
}

static Napi::Value StartPushToTalk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (pttRunning) {
    return Napi::Boolean::New(env, true);
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Callback function expected").ThrowAsJavaScriptException();
    return env.Null();
  }

  pttCallback = Napi::ThreadSafeFunction::New(
    env, info[0].As<Napi::Function>(), "ptt_callback", 0, 1
  );

  pttRunning = true;
  pttKeyDown = false;

  pttThread = std::thread([]() {
    @autoreleasepool {
      CGEventMask mask = (1 << kCGEventFlagsChanged) | (1 << kCGEventKeyDown) | (1 << kCGEventKeyUp);

      pttEventTap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionDefault,  // active tap — can consume events
        mask,
        PttEventCallback,
        nullptr
      );

      if (!pttEventTap) {
        NSLog(@"[DictateAI] Failed to create event tap — check Accessibility permission");
        pttRunning = false;
        return;
      }

      pttRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, pttEventTap, 0);
      CFRunLoopAddSource(CFRunLoopGetCurrent(), pttRunLoopSource, kCFRunLoopCommonModes);
      CGEventTapEnable(pttEventTap, true);

      NSLog(@"[DictateAI] Push-to-talk monitor started (hold Right Option)");

      while (pttRunning) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
      }

      CGEventTapEnable(pttEventTap, false);
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), pttRunLoopSource, kCFRunLoopCommonModes);
      CFRelease(pttRunLoopSource);
      CFRelease(pttEventTap);
      pttRunLoopSource = nullptr;
      pttEventTap = nullptr;

      NSLog(@"[DictateAI] Push-to-talk monitor stopped");
    }
  });

  return Napi::Boolean::New(env, true);
}

static Napi::Value StopPushToTalk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!pttRunning) return Napi::Boolean::New(env, false);

  pttRunning = false;
  pttKeyDown = false;

  if (pttThread.joinable()) {
    pttThread.join();
  }

  pttCallback.Release();
  return Napi::Boolean::New(env, true);
}

static Napi::Value SetPttKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    Napi::TypeError::New(env, "Expected (keyCode, flagMask, isModifier, requiredModifiers?)").ThrowAsJavaScriptException();
    return env.Null();
  }

  pttKeyCode = (CGKeyCode)info[0].As<Napi::Number>().Uint32Value();
  pttFlagMask = (CGEventFlags)info[1].As<Napi::Number>().Int64Value();
  pttIsModifierKey = info[2].As<Napi::Boolean>().Value();
  pttRequiredModifiers = info.Length() > 3 ? (CGEventFlags)info[3].As<Napi::Number>().Int64Value() : 0;
  pttKeyDown = false;

  NSLog(@"[DictateAI] PTT key updated: keyCode=%d flagMask=0x%llx isModifier=%d reqMods=0x%llx",
        pttKeyCode, (unsigned long long)pttFlagMask, pttIsModifierKey, (unsigned long long)pttRequiredModifiers);

  return Napi::Boolean::New(env, true);
}

// Send Cmd+Z to the frontmost app
static bool SendUndo() {
  CGEventRef keyDown = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_Z, true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_Z, false);

  if (!keyDown || !keyUp) {
    if (keyDown) CFRelease(keyDown);
    if (keyUp) CFRelease(keyUp);
    return false;
  }

  CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);
  CGEventPost(kCGAnnotatedSessionEventTap, keyDown);
  CGEventPost(kCGAnnotatedSessionEventTap, keyUp);
  CFRelease(keyDown);
  CFRelease(keyUp);

  return true;
}

// Get the screen position of the text cursor (insertion point) via AX API
static Napi::Value GetTextCursorPosition(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("available", false);

  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  AXUIElementRef focusedElement = nullptr;
  AXError err = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);
  CFRelease(systemWide);

  if (err != kAXErrorSuccess || !focusedElement) {
    NSLog(@"[DictateAI] GetTextCursorPosition: no focused element (err=%d)", (int)err);
    return result;
  }

  // Log what element we found
  CFTypeRef role = nullptr;
  AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &role);
  pid_t pid = 0;
  AXUIElementGetPid(focusedElement, &pid);
  NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  NSLog(@"[DictateAI] GetTextCursorPosition: focused=%@ app=%@ role=%@",
        focusedElement, app.localizedName ?: @"unknown",
        role ? (__bridge NSString*)role : @"unknown");
  if (role) CFRelease(role);

  // Strategy 1: Try kAXBoundsForRangeParameterizedAttribute with the character
  // at or just before the cursor (a zero-length range often returns degenerate rects)
  CFTypeRef selectedRange = nullptr;
  err = AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextRangeAttribute, &selectedRange);
  NSLog(@"[DictateAI] GetTextCursorPosition: selectedTextRange err=%d", (int)err);
  if (err == kAXErrorSuccess && selectedRange) {
    CFRange range;
    if (AXValueGetValue((AXValueRef)selectedRange, (AXValueType)kAXValueCFRangeType, &range)) {
      NSLog(@"[DictateAI] GetTextCursorPosition: cursor at location=%ld length=%ld", (long)range.location, (long)range.length);
      // Try a 1-char range at cursor (or just before if at end)
      CFRange charRange;
      if (range.location > 0) {
        charRange = CFRangeMake(range.location - 1, 1);
      } else {
        charRange = CFRangeMake(0, 1);
      }

      AXValueRef charRangeValue = AXValueCreate((AXValueType)kAXValueCFRangeType, &charRange);
      CFTypeRef boundsValue = nullptr;
      err = AXUIElementCopyParameterizedAttributeValue(
          focusedElement, kAXBoundsForRangeParameterizedAttribute, charRangeValue, &boundsValue);
      CFRelease(charRangeValue);

      NSLog(@"[DictateAI] GetTextCursorPosition: boundsForRange err=%d", (int)err);
      if (err == kAXErrorSuccess && boundsValue) {
        CGRect bounds;
        if (AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueCGRectType, &bounds)) {
          NSLog(@"[DictateAI] GetTextCursorPosition: bounds x=%.0f y=%.0f w=%.0f h=%.0f",
                bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
          if (bounds.size.width > 0 || bounds.size.height > 0) {
            result.Set("available", true);
            // If we used the char before cursor, position at its right edge
            if (range.location > 0) {
              result.Set("x", Napi::Number::New(env, bounds.origin.x + bounds.size.width));
            } else {
              result.Set("x", Napi::Number::New(env, bounds.origin.x));
            }
            result.Set("y", Napi::Number::New(env, bounds.origin.y));
            result.Set("width", Napi::Number::New(env, bounds.size.width));
            result.Set("height", Napi::Number::New(env, bounds.size.height));
            CFRelease(boundsValue);
            CFRelease(selectedRange);
            CFRelease(focusedElement);
            return result;
          }
        }
        CFRelease(boundsValue);
      }
    }
    CFRelease(selectedRange);
  }

  // Strategy 2: Fall back to the focused element's own position + size
  CFTypeRef posValue = nullptr;
  CFTypeRef sizeValue = nullptr;
  err = AXUIElementCopyAttributeValue(focusedElement, kAXPositionAttribute, &posValue);
  AXError err2 = AXUIElementCopyAttributeValue(focusedElement, kAXSizeAttribute, &sizeValue);

  if (err == kAXErrorSuccess && err2 == kAXErrorSuccess && posValue && sizeValue) {
    CGPoint pos;
    CGSize size;
    if (AXValueGetValue((AXValueRef)posValue, (AXValueType)kAXValueCGPointType, &pos) &&
        AXValueGetValue((AXValueRef)sizeValue, (AXValueType)kAXValueCGSizeType, &size)) {
      result.Set("available", true);
      result.Set("x", Napi::Number::New(env, pos.x + size.width / 2));
      result.Set("y", Napi::Number::New(env, pos.y + size.height));
      result.Set("width", Napi::Number::New(env, size.width));
      result.Set("height", Napi::Number::New(env, size.height));
      result.Set("fallback", true);
    }
  }

  if (posValue) CFRelease(posValue);
  if (sizeValue) CFRelease(sizeValue);
  CFRelease(focusedElement);
  return result;
}

// --- N-API bindings ---

static Napi::Value UndoLastInjection(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::Boolean::New(env, SendUndo());
}

static Napi::Value InjectText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "String argument expected").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string text = info[0].As<Napi::String>().Utf8Value();
  if (text.empty()) return Napi::String::New(env, "empty");

  // Try strategies in order
  if (InjectViaAccessibility(text)) return Napi::String::New(env, "accessibility");
  if (InjectViaKeystrokes(text)) return Napi::String::New(env, "keystrokes");
  if (InjectViaClipboard(text)) return Napi::String::New(env, "clipboard");

  return Napi::String::New(env, "failed");
}

static Napi::Value CheckAccessibilityPermission(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  NSDictionary* opts = @{(__bridge NSString*)kAXTrustedCheckOptionPrompt: @YES};
  bool trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);

  return Napi::Boolean::New(env, trusted);
}

static Napi::Value GetFocusedElementInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  AXUIElementRef focusedElement = nullptr;
  AXError err = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);
  CFRelease(systemWide);

  if (err != kAXErrorSuccess || !focusedElement) {
    result.Set("available", false);
    return result;
  }

  result.Set("available", true);

  CFTypeRef role = nullptr;
  if (AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &role) == kAXErrorSuccess && role) {
    result.Set("role", Napi::String::New(env, [(__bridge NSString*)role UTF8String]));
    CFRelease(role);
  }

  CFTypeRef title = nullptr;
  if (AXUIElementCopyAttributeValue(focusedElement, kAXTitleAttribute, &title) == kAXErrorSuccess && title) {
    result.Set("title", Napi::String::New(env, [(__bridge NSString*)title UTF8String]));
    CFRelease(title);
  }

  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(focusedElement, kAXValueAttribute, &value) == kAXErrorSuccess && value) {
    if (CFGetTypeID(value) == CFStringGetTypeID()) {
      result.Set("value", Napi::String::New(env, [(__bridge NSString*)value UTF8String]));
    }
    CFRelease(value);
  }

  // Get the owning app
  pid_t pid = 0;
  if (AXUIElementGetPid(focusedElement, &pid) == kAXErrorSuccess) {
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app.localizedName) {
      result.Set("app", Napi::String::New(env, [app.localizedName UTF8String]));
    }
    if (app.bundleIdentifier) {
      result.Set("bundleId", Napi::String::New(env, [app.bundleIdentifier UTF8String]));
    }
  }

  CFRelease(focusedElement);
  return result;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("injectText", Napi::Function::New(env, InjectText));
  exports.Set("undoLastInjection", Napi::Function::New(env, UndoLastInjection));
  exports.Set("checkAccessibilityPermission", Napi::Function::New(env, CheckAccessibilityPermission));
  exports.Set("getFocusedElementInfo", Napi::Function::New(env, GetFocusedElementInfo));
  exports.Set("startPushToTalk", Napi::Function::New(env, StartPushToTalk));
  exports.Set("stopPushToTalk", Napi::Function::New(env, StopPushToTalk));
  exports.Set("setPttKey", Napi::Function::New(env, SetPttKey));
  exports.Set("getTextCursorPosition", Napi::Function::New(env, GetTextCursorPosition));
  return exports;
}

NODE_API_MODULE(text_injection, Init)
