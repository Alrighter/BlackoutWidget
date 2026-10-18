import koffi from 'koffi';
import { MacNativeGlass } from '../../../src/main/widget/glass-darwin';
import { LIBOBJC_PATH, loadObjc, type KoffiLike, type ObjcBindings } from '../../../src/main/widget/objc-darwin';
import { MacDesktopPinner } from '../../../src/main/widget/pin-darwin';
import type { PinGuard } from '../../../src/main/widget/pin-guard';

/**
 * The only suite that loads the real koffi (the fakes suites never load the native addon). The prototype parse check
 * runs everywhere; the rest calls the real Objective-C runtime and runs on macOS only, as a CI step before the dmg
 * build (.github/workflows/build-mac.yml), so a wrong FFI declaration fails there instead of crashing on the Mac.
 */

/** Records the prototypes loadObjc declares, without loading anything. */
function declaredPrototypes(): string[] {
  const defs: string[] = [];
  loadObjc({ load: () => ({ func: def => { defs.push(def); return () => 0; } }) });
  return defs;
}

test('every prototype loadObjc declares parses with the real koffi (syntax and arity; long is 4 bytes on Windows)', () => {
  const defs = declaredPrototypes();
  expect(defs.length).toBe(8);
  const tag = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  defs.forEach((def, i) => {
    // koffi.proto registers a named type, so give each a unique name; lib.func itself accepts repeated symbols.
    const t = koffi.type(koffi.proto(def.replace(/(\w+)\(/, `$1_${tag}_${i}(`))) as unknown as
      { proto: { arguments: unknown[] } };
    expect(t.proto.arguments.length).toBe((def.match(/,/g)?.length ?? 0) + 1);
  });
});

const APPKIT_PATH = '/System/Library/Frameworks/AppKit.framework/AppKit';

/** Which class must implement each selector the pinner and the glass send (instance methods). */
const RECEIVERS: Record<string, 'NSView' | 'NSWindow' | 'CALayer'> = {
  'window': 'NSView', // -[NSView window]
  'contentView': 'NSWindow',
  'setLevel:': 'NSWindow',
  'setCollectionBehavior:': 'NSWindow',
  'setCanHide:': 'NSWindow',
  'setWantsLayer:': 'NSView',
  'layer': 'NSView',
  'setCornerRadius:': 'CALayer',
  'setMasksToBounds:': 'CALayer',
};

/** The distinct selector names MacDesktopPinner and MacNativeGlass register at construction (over a recording runtime). */
function registeredSelectors(): string[] {
  const names = new Set<string>(); // both register 'window'
  const recorder = { sel: (name: string) => { names.add(name); return 1n; } } as unknown as ObjcBindings;
  const guard: PinGuard = { disabled: false, run: fn => fn(), release: () => {} };
  new MacDesktopPinner(recorder, guard);
  new MacNativeGlass(recorder, guard);
  return [...names];
}

// Runs everywhere (no native call): a selector added to the pinner or the glass must get its receiving class below.
test('every selector the pinner and the glass register has its receiving class listed for the macOS check', () => {
  expect(registeredSelectors().sort()).toEqual(Object.keys(RECEIVERS).sort());
});

describe.skipIf(process.platform !== 'darwin')('the real Objective-C runtime (macOS only)', () => {
  // Loaded in beforeAll: a skipped describe still runs its body to collect the tests, and these dylibs exist on macOS only.
  let objc: ObjcBindings;
  let libs: unknown[] = []; // keeps the loaded libraries referenced for the whole suite
  let respondsTo: (cls: bigint, sel: bigint) => boolean;
  let getDouble: (self: bigint, op: bigint) => number;
  let getBool: (self: bigint, op: bigint) => boolean;
  beforeAll(() => {
    objc = loadObjc(koffi as unknown as KoffiLike);
    // Test-only probes, not in ObjcBindings, each declared with its exact prototype (objc/runtime.h, objc/message.h).
    const libobjc = koffi.load(LIBOBJC_PATH);
    respondsTo = libobjc.func('bool class_respondsToSelector(uintptr_t cls, uintptr_t sel)') as typeof respondsTo;
    getDouble = libobjc.func('double objc_msgSend(uintptr_t self, uintptr_t op)') as typeof getDouble;
    getBool = libobjc.func('bool objc_msgSend(uintptr_t self, uintptr_t op)') as typeof getBool;
    libs = [libobjc];
  });

  test('LP64: long and unsigned long are 8 bytes, as NSInteger / NSUInteger', () => {
    expect(koffi.sizeof('long')).toBe(8);
    expect(koffi.sizeof('unsigned long')).toBe(8);
  });

  test('CGWindowLevelForKey(kCGDesktopIconWindowLevelKey = 18) is the desktop icon level, near INT32_MIN', () => {
    const level = objc.windowLevelForKey(18);
    expect(typeof level).toBe('number');
    expect(level).toBeLessThan(-2_000_000_000); // INT32_MIN + 45 on current macOS
  });

  test('[NSObject class] is not nil', () => {
    expect(objc.msgId(objc.cls('NSObject'), objc.sel('class'))).not.toBe(0n);
  });

  describe('with AppKit loaded (NSView and NSWindow live in AppKit, which a plain node process has not loaded)', () => {
    beforeAll(() => { libs.push(koffi.load(APPKIT_PATH)); });

    test('NSView, NSWindow and CALayer exist', () => {
      for (const name of ['NSView', 'NSWindow', 'CALayer']) expect([name, objc.cls(name)]).not.toEqual([name, 0n]);
    });

    test('every selector the pinner and the glass register is implemented by the class it is sent to', () => {
      for (const name of registeredSelectors()) {
        const sel = objc.sel(name);
        expect(sel).not.toBe(0n);
        expect([name, RECEIVERS[name], respondsTo(objc.cls(RECEIVERS[name]), sel)]).toEqual([name, RECEIVERS[name], true]);
      }
    });

    test('a real CALayer takes setCornerRadius: (double) and setMasksToBounds: (BOOL) through the declared variants', () => {
      const layer = objc.msgId(objc.cls('CALayer'), objc.sel('new'));
      expect(layer).not.toBe(0n);
      objc.msgVoidDouble(layer, objc.sel('setCornerRadius:'), 22);
      objc.msgVoidBool(layer, objc.sel('setMasksToBounds:'), true);
      expect(getDouble(layer, objc.sel('cornerRadius'))).toBe(22);
      expect(getBool(layer, objc.sel('masksToBounds'))).toBe(true);
    });
  });
});
