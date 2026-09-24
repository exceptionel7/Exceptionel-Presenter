/**
 * Preload for the AUDIENCE OUTPUT window.
 *
 * Deliberately tiny. This window renders and does nothing else — it cannot advance a
 * slide, edit a song, or change a setting. An audience display should never be one bug
 * away from mutating the library.
 *
 * Camera streams are opened here via getUserMedia in the renderer and never cross IPC
 * (docs/ARCHITECTURE.md §7), which is why no camera channel is needed in this surface.
 */

import { IPC_CHANNELS, OUTPUT_ALLOWED_CHANNELS, OUTPUT_ALLOWED_EVENTS } from '../shared/ipc-contract.ts';
import { exposeApi } from './bridge.ts';

exposeApi({
  role: 'output',
  channels: OUTPUT_ALLOWED_CHANNELS,
  events: OUTPUT_ALLOWED_EVENTS,
  allChannels: IPC_CHANNELS,
});
