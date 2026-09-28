import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EXCEPTIONEL PRESENTER — width constraints of the operator shell.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. There is no browser, no Electron and no display in this build
 * environment, so NOTHING HERE MEASURES A RENDERED LAYOUT. It cannot tell you that a button was visible
 * on screen.
 *
 * What it does instead is arithmetic on the REAL class strings: it extracts the width tokens actually
 * present in the source, resolves them to pixels through Tailwind's scale, and checks that the
 * non-shrinkable parts of the shell leave usable room at 1024, 1280 and 1920. That is a genuine
 * constraint — the sum of fixed widths is not a matter of opinion — and it is the strongest
 * deterministic check available here. A rendered verification remains outstanding and is stated as such
 * in the milestone report.
 *
 * WHY IT MATTERS MORE THAN USUAL. `styles.css` sets `body { overflow: hidden }`, so the document cannot
 * scroll. Anything wider than the viewport is therefore CLIPPED SILENTLY — a control can become
 * unreachable with nothing on screen to say so. Bounding the fixed widths is what prevents that.
 */

const RENDERER = join(process.cwd(), 'src', 'renderer');
const read = (...parts: string[]): string => readFileSync(join(RENDERER, ...parts), 'utf8');

const APP = read('operator', 'App.tsx');
const STYLES = read('styles.css');

/** Tailwind's spacing scale, in pixels at the default 16px root. */
const TAILWIND_WIDTH: Readonly<Record<string, number>> = {
  'w-52': 208,
  'w-72': 288,
  'w-80': 320,
};

/** Resolves a width class to pixels: a scale token, or an arbitrary `w-[…]` value. */
function widthToPx(token: string): number {
  const scale = TAILWIND_WIDTH[token];
  if (scale !== undefined) return scale;

  const arbitrary = /^w-\[(\d+(?:\.\d+)?)(rem|px)\]$/.exec(token);
  if (arbitrary) {
    const value = Number(arbitrary[1]);
    return arbitrary[2] === 'rem' ? value * 16 : value;
  }
  throw new Error(`unrecognised width token "${token}" — add it to TAILWIND_WIDTH so the sum stays real`);
}

/** The viewport widths the operator application must remain usable at. */
const VIEWPORTS = [1024, 1280, 1920] as const;

/** Sections with a fixed sidebar beside a shrinkable work area. */
const SECTIONS = ['Service', 'Camera', 'Bible', 'Songs'] as const;

interface Sidebar {
  /** Width below the `xl` breakpoint (1280px). */
  base: number;
  /** Width at `xl` and above. */
  wide: number;
}

/**
 * Extracts a section's sidebar width from its actual class string.
 *
 * Read from source rather than hard-coded, so this test keeps telling the truth when someone changes a
 * class — which is the only way an arithmetic check like this stays worth having.
 */
function sidebarOf(section: string): Sidebar {
  const source = read('operator', 'sections', `${section}.tsx`);
  // Allows breakpoint-prefixed tokens, e.g. `w-72 xl:w-[22rem] shrink-0`.
  const match = /className="((?:(?:xl:)?w-\S+\s+)*(?:xl:)?w-\S+)\s+shrink-0 border-r/.exec(source);
  assert.ok(match, `${section}.tsx must have a shrink-0 sidebar with an explicit width`);

  const tokens = (match[1] ?? '').split(/\s+/).filter(Boolean);
  const base = tokens.find((token) => !token.includes(':'));
  const wide = tokens.find((token) => token.startsWith('xl:'));

  assert.ok(base, `${section}.tsx sidebar must declare a base width`);
  const basePx = widthToPx(base);
  return { base: basePx, wide: wide === undefined ? basePx : widthToPx(wide.slice('xl:'.length)) };
}

function navWidth(): number {
  const match = /<nav className="(w-\S+) shrink-0/.exec(APP);
  assert.ok(match, 'the navigation rail must have an explicit, non-shrinking width');
  return widthToPx(match[1] ?? '');
}

// ── the constraint that actually matters ─────────────────────────────────────────

test('THE OPERATOR SHELL FITS 1024, 1280 AND 1920 WITH ROOM TO WORK', () => {
  /*
   * The shell's minimum width is the navigation rail plus the widest section sidebar, because every
   * work area is `flex-1 min-w-0` and can therefore shrink to nothing. What must be checked is that it
   * does not HAVE to: enough has to be left for a preview pane and its controls to stay usable.
   *
   * 420px is the floor — roughly a 16:9 preview at 420x236 plus padding, which is the smallest at which
   * an operator can still judge what is on screen.
   */
  const MINIMUM_WORK_AREA = 420;
  const nav = navWidth();

  for (const viewport of VIEWPORTS) {
    for (const section of SECTIONS) {
      const sidebar = sidebarOf(section);
      // Below 1280 the base width applies; at and above it, the `xl` width.
      const width = viewport >= 1280 ? sidebar.wide : sidebar.base;
      const workArea = viewport - nav - width;

      assert.ok(
        workArea >= MINIMUM_WORK_AREA,
        `${section} at ${String(viewport)}px: nav ${String(nav)} + sidebar ${String(width)} leaves ` +
          `${String(workArea)}px, below the ${String(MINIMUM_WORK_AREA)}px a preview needs`,
      );
    }
  }
});

test('the shell cannot exceed the narrowest supported viewport', () => {
  // The hard version of the same sum: fixed widths alone must never fill 1024px, or the work area would
  // be clipped away entirely with no scrollbar to reveal it.
  const nav = navWidth();
  for (const section of SECTIONS) {
    const sidebar = sidebarOf(section);
    assert.ok(
      nav + sidebar.base < VIEWPORTS[0],
      `${section}: ${String(nav + sidebar.base)}px of fixed width does not fit ${String(VIEWPORTS[0])}px`,
    );
  }
});

test('EVERY FIXED SIDEBAR IS PAIRED WITH A SHRINKABLE WORK AREA', () => {
  /*
   * The structural rule that makes the arithmetic above sufficient. A flex item only shrinks below its
   * content's intrinsic minimum if it carries `min-w-0`; without it a long unbroken string can push the
   * whole row wider than the viewport, and with `body { overflow: hidden }` the excess is clipped rather
   * than scrolled.
   */
  for (const section of SECTIONS) {
    const source = read('operator', 'sections', `${section}.tsx`);
    assert.match(source, /shrink-0 border-r/, `${section} has a fixed sidebar`);
    assert.match(
      source,
      /className="flex-1 min-w-0/,
      `${section} must pair it with a flex-1 min-w-0 work area, or a long string can push the shell wide`,
    );
  }

  // And the shell itself.
  assert.match(APP, /<main className="flex-1 min-w-0/);
});

test('the navigation rail never shrinks and never scrolls horizontally', () => {
  // It is the only way to leave a section. If it could shrink or be clipped, an operator could become
  // stranded mid-service.
  assert.match(APP, /<nav className="w-\S+ shrink-0/);
  assert.match(APP, /overflow-y-auto/, 'it scrolls vertically when the section list is long');
  assert.equal(/<nav className="[^"]*overflow-x/.test(APP), false, 'but never horizontally');
});

// ── the silent-clipping hazard ───────────────────────────────────────────────────

test('OVERFLOW IS CLIPPED, NOT SCROLLED — WHICH IS WHY THE SUMS ABOVE ARE ENFORCED', () => {
  /*
   * Documented as a test so the reasoning cannot be lost. `body { overflow: hidden }` is right for a
   * kiosk-style application — a stray scrollbar during a service would be worse than none — but it means
   * an overflowing shell fails INVISIBLY. The width arithmetic is the compensating control.
   */
  assert.match(STYLES, /body\s*\{[^}]*overflow:\s*hidden/s);
});

test('breakpoint reductions are responsive, not flat', () => {
  // A flat reduction would shrink the 1920 desktop layout too, which is the one that works. The Service
  // sidebar is narrower only below `xl`.
  const service = sidebarOf('Service');
  assert.ok(service.wide >= service.base, 'the wide layout must not be smaller than the narrow one');
  assert.match(
    read('operator', 'sections', 'Service.tsx'),
    /w-72 xl:w-\[22rem\] shrink-0/,
    'the Service sidebar grows at xl rather than being reduced everywhere',
  );
});

test('the preview and live panes stack below xl and sit side by side above it', () => {
  /*
   * Two 16:9 panes side by side inside a 1024px viewport would be about 250px each — too small to judge
   * what is on the projector. They stack instead, and pair up once there is room.
   */
  assert.match(
    read('operator', 'sections', 'Service.tsx'),
    /grid-cols-1 xl:grid-cols-2/,
    'one column below xl, two above',
  );
});
