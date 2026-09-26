/**
 * Shared id scheme between the main-process camera registry and the renderers.
 *
 * Duplicated deliberately rather than imported from src/main: renderer code must not pull in a
 * main-process module, and this is one line whose shape is asserted by a test.
 */
export const WIRELESS_SOURCE_PREFIX = 'phone:';

export const sourceIdForSession = (sessionId: string): string => `${WIRELESS_SOURCE_PREFIX}${sessionId}`;

export const sessionIdFromSource = (sourceId: string): string | null =>
  sourceId.startsWith(WIRELESS_SOURCE_PREFIX) ? sourceId.slice(WIRELESS_SOURCE_PREFIX.length) : null;
