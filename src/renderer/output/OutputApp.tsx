/**
 * EXCEPTIONEL PRESENTER — the AUDIENCE OUTPUT renderer (Sections 5, 6, 21).
 *
 * This window shows only the presentation. No menus, no buttons, no cursor, no operator
 * previews — ever. It is a pure render target driven entirely by `live:state` broadcasts
 * from the main process, and its preload surface cannot mutate anything.
 *
 * The layer stack (docs/ARCHITECTURE.md §5) is what makes Camera + Lyrics and
 * Camera + Scripture fall out of one mechanism rather than three special cases:
 *
 *   z4  FOREGROUND  logo / watermark
 *   z3  TEXT        lyrics | scripture | announcement
 *   z2  MEDIA       image | video | animated background
 *   z1  CAMERA      live local MediaStream
 *   z0  BASE        solid colour | gradient
 */

import { useEffect, useState } from 'react';
import type { Theme } from '@shared/domain/entities.ts';
import { resolveAudienceVisibility, type Cue, type LiveState } from '@shared/domain/live-state.ts';
import { resolveThemeSpecOrBase } from '@shared/domain/theme.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent } from '@ui/hooks.ts';
import { SlideCanvas } from '@ui/SlideCanvas.tsx';
import { useWirelessCameraHost } from './useWirelessCameraHost.ts';

export function OutputApp(): JSX.Element {
  const [live, setLive] = useState<LiveState | null>(null);
  const [cues, setCues] = useState<readonly Cue[]>([]);
  const [themes, setThemes] = useState<readonly Theme[]>([]);

  useIpcEvent('live:state', setLive);
  useIpcEvent('live:cues', ({ cues: next }) => setCues(next));

  /*
   * This window owns every phone camera connection and republishes each stream to the operator
   * preview over a loopback peer connection. It is mounted here rather than in the operator
   * window because a MediaStream cannot cross a process boundary, so whichever renderer will
   * eventually drive the projector has to be the one that receives the phone.
   */
  const wireless = useWirelessCameraHost();

  /*
   * Pulled once on mount: this window may open mid-service and must render the correct slide
   * immediately rather than staying black until the next operator action.
   *
   * Themes are fetched here and resolved locally. The output window is allowed `themes:list` and
   * nothing else from the library — it cannot read songs or services — so cues arrive carrying their
   * own text and only the styling is looked up. Resolving client-side also means advancing a slide
   * costs no IPC round trip.
   */
  useEffect(() => {
    void client.invoke('live:getState').then((result) => {
      if (result.ok) setLive(result.data);
    });
    void client.invoke('themes:list').then((result) => {
      if (result.ok) setThemes(result.data);
    });
  }, []);

  // Until state arrives, black is the only safe thing to show.
  if (!live) return <div className="fixed inset-0 bg-black" />;

  const visibility = resolveAudienceVisibility(live);
  const cue = live.cueIndex >= 0 ? (cues[live.cueIndex] ?? null) : null;

  /*
   * The cue's own theme, falling back to the live state's, then to the base spec.
   *
   * Never null: a missing theme must not leave the projector with unstyled text mid-service. The
   * operator's Service view flags an unresolvable theme, which is where that problem belongs.
   */
  const spec = resolveThemeSpecOrBase(themes, cue?.themeId ?? live.themeId);

  return (
    <SlideCanvas
      className="fixed inset-0"
      spec={spec}
      lines={cue?.lines ?? []}
      visibility={visibility}
      cameraStream={wireless.liveStream}
      {...(cue ? { transitionKey: cue.id } : {})}
      // `annotate` is deliberately absent. The congregation must never be shown a diagnostic.
    />
  );
}

/*
 * The hand-rolled `Stage` (a resize listener plus a `transform: scale()` on a fixed 1920x1080 div)
 * and the hard-coded text block that printed `cue.label` at a fixed 84pt both lived here until
 * Phase 3. They are gone, replaced by `SlideCanvas`.
 *
 * Two problems went with them. The text was not themed at all — a theme's font, colour, alignment,
 * shadow, outline and scrim were simply ignored on the audience screen while the Themes gallery
 * previewed them faithfully. And it printed the operator's LABEL ("Way Maker - Chorus") rather than
 * the lyrics, because through Phase 2 a cue had no body to print.
 */
