export const LIBOBJC_PATH = '/usr/lib/libobjc.A.dylib';
export const COREGRAPHICS_PATH = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics';

/** Objective-C objects, classes and selectors cross the FFI as uintptr_t and are bigint on the JS side. */
export type ObjcPtr = bigint;

export interface ObjcBindings {
  /** objc_getClass: the class named `name`, or 0n. */
  cls(name: string): ObjcPtr;
  /** sel_registerName: the selector for `name`, e.g. 'setLevel:'. */
  sel(name: string): ObjcPtr;
  /** `[obj sel]` returning an object (id). */
  msgId(obj: ObjcPtr, sel: ObjcPtr): ObjcPtr;
  /** `[obj sel:n]`, n an NSInteger. */
  msgVoidLong(obj: ObjcPtr, sel: ObjcPtr, n: number): void;
  /** `[obj sel:n]`, n an NSUInteger. */
  msgVoidULong(obj: ObjcPtr, sel: ObjcPtr, n: number): void;
  /** `[obj sel:b]`, b a BOOL. */
  msgVoidBool(obj: ObjcPtr, sel: ObjcPtr, b: boolean): void;
  /** `[obj sel:d]`, d a CGFloat. */
  msgVoidDouble(obj: ObjcPtr, sel: ObjcPtr, d: number): void;
  /** CoreGraphics CGWindowLevelForKey. */
  windowLevelForKey(key: number): number;
}

/** The part of koffi used here; tests pass a fake. */
export interface KoffiLike {
  load(path: string): { func(definition: string): (...args: any[]) => unknown };
}

type Ptr = ObjcPtr | number; // what koffi hands back for a uintptr_t: number while it fits, else bigint
const ptr = (v: Ptr): ObjcPtr => BigInt(v);

/**
 * macOS (arm64) Objective-C runtime and CoreGraphics bindings. Only `koffi.load` and declarations happen here;
 * nothing native is called until a binding is, so callers can put every call behind the crash guard.
 *
 * objc_msgSend has no fixed prototype (objc/message.h: cast it to the method's exact type before calling). On
 * arm64 Apple passes variadic arguments on the stack but fixed ones in registers, so it is never declared variadic:
 * each variant below is its own non-variadic declaration of the same symbol, which koffi allows. Argument types:
 * id / Class / SEL are pointers (objc/objc.h) -> uintptr_t; NSInteger / NSUInteger are long / unsigned long on
 * LP64 (objc/NSObjCRuntime.h); BOOL is bool on arm64 (objc/objc.h, OBJC_BOOL_IS_BOOL); CGFloat is double on 64-bit
 * (CoreGraphics/CGBase.h); CGWindowLevel and CGWindowLevelKey are int32_t (CoreGraphics/CGWindowLevel.h).
 */
export function loadObjc(ffi: KoffiLike = require('koffi') as KoffiLike): ObjcBindings {
  const objc = ffi.load(LIBOBJC_PATH);
  const cg = ffi.load(COREGRAPHICS_PATH);
  // objc/runtime.h
  const getClass = objc.func('uintptr_t objc_getClass(const char *name)') as (name: string) => Ptr;
  const registerName = objc.func('uintptr_t sel_registerName(const char *name)') as (name: string) => Ptr;
  // objc/message.h
  const msgId = objc.func('uintptr_t objc_msgSend(uintptr_t self, uintptr_t op)') as (self: ObjcPtr, op: ObjcPtr) => Ptr;
  const msgVoidLong = objc.func('void objc_msgSend(uintptr_t self, uintptr_t op, long value)') as
    (self: ObjcPtr, op: ObjcPtr, value: number) => void;
  const msgVoidULong = objc.func('void objc_msgSend(uintptr_t self, uintptr_t op, unsigned long value)') as
    (self: ObjcPtr, op: ObjcPtr, value: number) => void;
  const msgVoidBool = objc.func('void objc_msgSend(uintptr_t self, uintptr_t op, bool value)') as
    (self: ObjcPtr, op: ObjcPtr, value: boolean) => void;
  const msgVoidDouble = objc.func('void objc_msgSend(uintptr_t self, uintptr_t op, double value)') as
    (self: ObjcPtr, op: ObjcPtr, value: number) => void;
  // CoreGraphics/CGWindowLevel.h
  const levelForKey = cg.func('int32_t CGWindowLevelForKey(int32_t key)') as (key: number) => number;
  // Always called synchronously, never through koffi's .async: AppKit must run on the main thread.
  return {
    cls: name => ptr(getClass(name)),
    sel: name => ptr(registerName(name)),
    msgId: (obj, sel) => ptr(msgId(obj, sel)),
    msgVoidLong: (obj, sel, n) => { msgVoidLong(obj, sel, n); },
    msgVoidULong: (obj, sel, n) => { msgVoidULong(obj, sel, n); },
    msgVoidBool: (obj, sel, b) => { msgVoidBool(obj, sel, b); },
    msgVoidDouble: (obj, sel, d) => { msgVoidDouble(obj, sel, d); },
    windowLevelForKey: key => Number(levelForKey(key)),
  };
}
