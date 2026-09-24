/**
 * EXCEPTIONEL PRESENTER — operator navigation model (Section 3).
 *
 * The twelve sections, with an honest `phase` on each. `available: false` sections render
 * a NotImplemented panel naming the phase rather than a broken screen.
 */

export type SectionId =
  | 'dashboard'
  | 'service'
  | 'songs'
  | 'bible'
  | 'media'
  | 'camera'
  | 'presentation'
  | 'playlists'
  | 'themes'
  | 'outputs'
  | 'settings'
  | 'help';

export interface SectionDef {
  id: SectionId;
  label: string;
  /** Short glyph for the rail. Kept to text so no icon font is needed. */
  glyph: string;
  group: 'produce' | 'library' | 'system';
  available: boolean;
  phase: string;
  requirement: string;
  capabilities?: string[];
}

export const SECTIONS: readonly SectionDef[] = Object.freeze([
  {
    id: 'dashboard',
    label: 'Dashboard',
    glyph: '◱',
    group: 'produce',
    available: true,
    phase: 'Phase 2',
    requirement: 'Service overview, system status and quick actions.',
  },
  {
    id: 'service',
    label: 'Service',
    glyph: '≡',
    group: 'produce',
    available: false,
    phase: 'Phase 3 & 8',
    requirement:
      'The live production workspace: service playlist, preview and live output side by side, with transport controls.',
    capabilities: [
      'Drag-and-drop service running order',
      'Preview alongside the live audience output',
      'Previous / Next / Black / Clear / Live transport',
      'Per-item theme overrides and speaker notes',
      'Autosave with crash recovery',
    ],
  },
  {
    id: 'songs',
    label: 'Songs',
    glyph: '♪',
    group: 'library',
    available: true,
    phase: 'Phase 2',
    requirement: 'Song library with full-text search across titles and lyrics.',
  },
  {
    id: 'bible',
    label: 'Bible',
    glyph: '✝',
    group: 'library',
    available: false,
    phase: 'Phase 4',
    requirement:
      'Scripture module with reference parsing and keyword search. No scripture text is bundled — translations install from properly licensed or public-domain packages.',
    capabilities: [
      'Reference parsing: "John 3:16", "Psalm 23:1-6", "Rom 8"',
      'Single verse, verse range, multiple verses, whole passage',
      'Keyword search across an installed translation',
      'Translation management with recorded licence terms',
      'Send a passage straight to the audience screen',
    ],
  },
  {
    id: 'media',
    label: 'Media',
    glyph: '▣',
    group: 'library',
    available: false,
    phase: 'Phase 5',
    requirement: 'Media library for images, video, audio, backgrounds and logos.',
    capabilities: [
      'Import with duplicate detection by content hash',
      'Thumbnail generation and preview',
      'Streaming playback — large video is never loaded into memory whole',
      'Categories and favourites',
    ],
  },
  {
    id: 'camera',
    label: 'Camera',
    glyph: '◉',
    group: 'produce',
    available: false,
    phase: 'Phase 6',
    requirement:
      'Live camera input. Streams are opened locally in the renderer and never uploaded to the cloud.',
    capabilities: [
      'Detect, select, preview and switch USB cameras',
      'Named camera profiles (Pastor, Worship, Audience)',
      'Camera + Lyrics overlay with position and scrim controls',
      'Camera + Scripture overlay',
      'Extensible provider architecture for capture cards, NDI and RTSP',
    ],
  },
  {
    id: 'presentation',
    label: 'Presentation',
    glyph: '▤',
    group: 'produce',
    available: false,
    phase: 'Phase 3 & 9',
    requirement: 'Slide designer with text, images, shapes and logos on a normalised 1920×1080 canvas.',
    capabilities: [
      'Drag, resize, rotate, align, duplicate elements',
      'Full text controls: font, weight, shadow, outline, letter spacing',
      'Resolution-independent geometry — one slide fits 720p and 4K',
      'Per-slide theme overrides',
    ],
  },
  {
    id: 'playlists',
    label: 'Playlists',
    glyph: '☰',
    group: 'library',
    available: false,
    phase: 'Phase 8',
    requirement: 'Reusable service templates: Sunday Morning, Wednesday Worship, Christmas, Easter.',
    capabilities: ['Duplicate, rename, delete', 'Export and import', 'Build a service from a template'],
  },
  {
    id: 'themes',
    label: 'Themes',
    glyph: '◈',
    group: 'library',
    available: true,
    phase: 'Phase 2',
    requirement: 'The six built-in themes, with inheritance for custom variants.',
  },
  {
    id: 'outputs',
    label: 'Outputs',
    glyph: '▭',
    group: 'system',
    available: false,
    phase: 'Phase 7',
    requirement:
      "Display and projector management. Note: Electron's screen API does not report refresh rate, so that column will show as unavailable rather than guess.",
    capabilities: [
      'Detect every connected display with bounds and scale factor',
      'Assign presentation, preview and confidence roles',
      'Identify a display with an on-screen test pattern',
      'Park output safely if the projector disconnects mid-service',
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    glyph: '⚙',
    group: 'system',
    available: true,
    phase: 'Phase 2',
    requirement: 'Application preferences, keyboard shortcuts and diagnostics.',
  },
  {
    id: 'help',
    label: 'Help',
    glyph: '?',
    group: 'system',
    available: true,
    phase: 'Phase 2',
    requirement: 'Keyboard reference and build information.',
  },
]);

export const sectionById = (id: SectionId): SectionDef =>
  SECTIONS.find((section) => section.id === id) ?? SECTIONS[0]!;
