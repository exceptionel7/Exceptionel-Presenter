/**
 * Preload for the CONFIDENCE MONITOR (Section 23).
 *
 * Read-only, like the output window, but additionally allowed to read service context so
 * it can show the next slide, speaker notes and service progress.
 */

import {
  CONFIDENCE_ALLOWED_CHANNELS,
  CONFIDENCE_ALLOWED_EVENTS,
  IPC_CHANNELS,
} from '../shared/ipc-contract.ts';
import { exposeApi } from './bridge.ts';

exposeApi({
  role: 'confidence',
  channels: CONFIDENCE_ALLOWED_CHANNELS,
  events: CONFIDENCE_ALLOWED_EVENTS,
  allChannels: IPC_CHANNELS,
});
