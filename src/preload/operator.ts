/**
 * Preload for the OPERATOR window — the full production interface.
 *
 * This is the only window trusted with the complete IPC contract.
 */

import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc-contract.ts';
import { exposeApi } from './bridge.ts';

exposeApi({
  role: 'operator',
  channels: 'all',
  events: IPC_EVENTS,
  allChannels: IPC_CHANNELS,
});
