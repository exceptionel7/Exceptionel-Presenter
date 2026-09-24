/**
 * EXCEPTIONEL PRESENTER — migration 0002: built-in themes and default shortcuts.
 *
 * Seed data lives in a migration (not in app startup code) so it is applied exactly once
 * and recorded. Startup seeding would either re-insert on every launch or need its own
 * "have I done this?" bookkeeping — which is what migrations already are.
 *
 * Themes here are the six from Section 16. Each carries a full ThemeSpec; user themes can
 * inherit from them and override individual fields (themes.parent_theme_id).
 *
 * IMMUTABLE once shipped — see 0001-init.ts.
 */

export const SQL = String.raw`
-- ── built-in themes (Section 16) ────────────────────────────────────────────────
-- font sizes are points on the normalised 1920x1080 design canvas.
-- padding values are fractions of the canvas, keeping text inside projector safe areas.

INSERT INTO themes (id, name, parent_theme_id, is_builtin, spec_json, created_at, updated_at) VALUES
('theme-modern-worship', 'Modern Worship', NULL, 1, '{
  "background": { "kind": "solid", "value": "#050B14" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 84,
    "fontWeight": 600,
    "color": "#FFFFFF",
    "align": "center",
    "lineHeight": 1.22,
    "letterSpacing": -0.01,
    "shadow": { "enabled": true, "color": "rgba(0,0,0,0.75)", "blur": 28, "offsetY": 4 },
    "outline": { "enabled": false, "color": "#000000", "width": 0 }
  },
  "padding": { "top": 0.1, "right": 0.08, "bottom": 0.1, "left": 0.08 },
  "textBox": { "enabled": false, "color": "#000000", "opacity": 0, "cornerRadius": 0 },
  "transition": { "kind": "crossfade", "durationMs": 320 }
}', datetime('now'), datetime('now')),

('theme-minimal-worship', 'Minimal Worship', NULL, 1, '{
  "background": { "kind": "solid", "value": "#000000" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 76,
    "fontWeight": 400,
    "color": "#F5F7FA",
    "align": "center",
    "lineHeight": 1.45,
    "letterSpacing": 0.01,
    "shadow": { "enabled": false, "color": "#000000", "blur": 0, "offsetY": 0 },
    "outline": { "enabled": false, "color": "#000000", "width": 0 }
  },
  "padding": { "top": 0.14, "right": 0.12, "bottom": 0.14, "left": 0.12 },
  "textBox": { "enabled": false, "color": "#000000", "opacity": 0, "cornerRadius": 0 },
  "transition": { "kind": "fade", "durationMs": 220 }
}', datetime('now'), datetime('now')),

-- Scripture runs smaller and left-aligned: prose in long verses reads far better
-- ragged-right than centred, where every line starts at a different x.
('theme-scripture', 'Scripture', NULL, 1, '{
  "background": { "kind": "gradient", "value": "linear-gradient(160deg,#0A1421 0%,#050B14 100%)" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 64,
    "fontWeight": 400,
    "color": "#FFFFFF",
    "align": "left",
    "lineHeight": 1.5,
    "letterSpacing": 0,
    "shadow": { "enabled": true, "color": "rgba(0,0,0,0.6)", "blur": 18, "offsetY": 2 },
    "outline": { "enabled": false, "color": "#000000", "width": 0 }
  },
  "padding": { "top": 0.12, "right": 0.1, "bottom": 0.12, "left": 0.1 },
  "textBox": { "enabled": false, "color": "#000000", "opacity": 0, "cornerRadius": 0 },
  "transition": { "kind": "fade", "durationMs": 260 }
}', datetime('now'), datetime('now')),

-- Camera overlay: text must stay legible over unpredictable video, so it gets a heavy
-- weight, a strong outline AND a scrim box. Background is the camera layer itself.
('theme-live-worship', 'Live Worship', NULL, 1, '{
  "background": { "kind": "camera", "value": "" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 72,
    "fontWeight": 700,
    "color": "#FFFFFF",
    "align": "center",
    "lineHeight": 1.25,
    "letterSpacing": 0,
    "shadow": { "enabled": true, "color": "rgba(0,0,0,0.9)", "blur": 32, "offsetY": 6 },
    "outline": { "enabled": true, "color": "rgba(0,0,0,0.85)", "width": 3 }
  },
  "padding": { "top": 0.55, "right": 0.07, "bottom": 0.08, "left": 0.07 },
  "textBox": { "enabled": true, "color": "#000000", "opacity": 0.38, "cornerRadius": 16 },
  "transition": { "kind": "fade", "durationMs": 260 }
}', datetime('now'), datetime('now')),

('theme-sermon', 'Sermon', NULL, 1, '{
  "background": { "kind": "solid", "value": "#0A1421" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 60,
    "fontWeight": 500,
    "color": "#FFFFFF",
    "align": "left",
    "lineHeight": 1.4,
    "letterSpacing": 0,
    "shadow": { "enabled": false, "color": "#000000", "blur": 0, "offsetY": 0 },
    "outline": { "enabled": false, "color": "#000000", "width": 0 }
  },
  "padding": { "top": 0.1, "right": 0.09, "bottom": 0.1, "left": 0.09 },
  "textBox": { "enabled": false, "color": "#000000", "opacity": 0, "cornerRadius": 0 },
  "transition": { "kind": "slide", "durationMs": 300 }
}', datetime('now'), datetime('now')),

('theme-announcement', 'Announcement', NULL, 1, '{
  "background": { "kind": "gradient", "value": "linear-gradient(135deg,#1F5FE8 0%,#0A1421 100%)" },
  "text": {
    "fontFamily": "Inter",
    "fontSize": 80,
    "fontWeight": 700,
    "color": "#FFFFFF",
    "align": "center",
    "lineHeight": 1.2,
    "letterSpacing": -0.01,
    "shadow": { "enabled": true, "color": "rgba(0,0,0,0.5)", "blur": 24, "offsetY": 4 },
    "outline": { "enabled": false, "color": "#000000", "width": 0 }
  },
  "padding": { "top": 0.12, "right": 0.1, "bottom": 0.12, "left": 0.1 },
  "textBox": { "enabled": false, "color": "#000000", "opacity": 0, "cornerRadius": 0 },
  "transition": { "kind": "crossfade", "durationMs": 340 }
}', datetime('now'), datetime('now'));

-- ── default keyboard shortcuts (Section 20) ─────────────────────────────────────
-- Stored rather than hard-coded so Section 20's "customisable later" needs no migration.
-- Note Space and ArrowRight both advance, as operators expect; they are distinct actions
-- pointing at the same behaviour, so the unique-accelerator index is not violated.

INSERT INTO shortcuts (action, accelerator, enabled) VALUES
('live.previous',    'ArrowLeft',  1),
('live.next',        'ArrowRight', 1),
('live.nextAlt',     'Space',      1),
('live.black',       'B',          1),
('live.clear',       'C',          1),
('live.fullscreen',  'F',          1),
('live.exitFullscreen', 'Escape',  1),
('camera.select1',   '1',          1),
('camera.select2',   '2',          1),
('camera.select3',   '3',          1),
('live.stop',        'Period',     1),
('service.save',     'CommandOrControl+S', 1),
('service.new',      'CommandOrControl+N', 1),
('search.focus',     'CommandOrControl+F', 1),
('output.toggle',    'CommandOrControl+Shift+O', 1);

-- ── default settings ────────────────────────────────────────────────────────────
-- Keys match the dotted-lowercase pattern enforced by vSettingWrite.

INSERT INTO settings (key, value_json, updated_at) VALUES
('app.theme',                    '"dark"',                  datetime('now')),
('app.firstRunCompleted',        'false',                   datetime('now')),
('presentation.defaultThemeId',  '"theme-modern-worship"',  datetime('now')),
('presentation.scriptureThemeId','"theme-scripture"',       datetime('now')),
('presentation.lyricsThemeId',   '"theme-modern-worship"',  datetime('now')),
('presentation.cameraThemeId',   '"theme-live-worship"',    datetime('now')),
('presentation.aspectRatio',     '"16:9"',                  datetime('now')),
('presentation.blackOnStartup',  'true',                    datetime('now')),
('bible.defaultTranslationId',   'null',                    datetime('now')),
('confidence.showTimer',         'true',                    datetime('now')),
('confidence.showNextSlide',     'true',                    datetime('now')),
('confidence.showNotes',         'true',                    datetime('now')),
('autosave.debounceMs',          '400',                     datetime('now')),
('cloud.syncEnabled',            'false',                   datetime('now'));
`;
