/**
 * CAMERA — local and wireless cameras (Sections 2, 3, 4, 5, 9, 13, 14).
 *
 * Shows real state only. Every status, resolution, frame rate and quality figure here comes from
 * the main-process state machine, which reaches `connected` solely on a real remote track. There
 * is no optimistic "connected" and no simulated video.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { CameraSource } from '@shared/domain/camera.ts';
import { describeSource } from '@shared/domain/camera.ts';
import {
  describeWirelessState,
  wirelessStateTone,
  type WirelessState,
} from '@shared/domain/wireless-camera-state.ts';
import { formatPin } from '@shared/domain/pairing.ts';
import type { PairingTicket, WirelessPhone, WirelessStatus } from '@shared/ipc-contract.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent, useMutation } from '@ui/hooks.ts';
import { createLoopbackSubscriber } from '@ui/loopback.ts';
import { EmptyState, FailureNotice, Panel, StatusDot } from '@ui/primitives.tsx';

export function CameraSection(): JSX.Element {
  const [status, setStatus] = useState<WirelessStatus | null>(null);
  const [sources, setSources] = useState<CameraSource[]>([]);
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const createSession = useMutation('wireless:createSession');
  const cancelSession = useMutation('wireless:cancelSession');
  const disconnect = useMutation('wireless:disconnect');
  const assign = useMutation('camera:assign');

  // The operator preview receives the phone's video over a loopback connection from the output
  // window, because a MediaStream cannot cross a process boundary.
  const subscriber = useMemo(() => createLoopbackSubscriber(), []);
  const [previewStreams, setPreviewStreams] = useState<Map<string, MediaStream>>(new Map());

  useIpcEvent('wireless:status', setStatus);
  useIpcEvent('camera:sources', setSources);
  useIpcEvent('media:relay', ({ message }) => subscriber.handleRelay(message));

  useEffect(() => {
    const unsubscribe = subscriber.onStream((id, stream) => {
      setPreviewStreams((current) => {
        const next = new Map(current);
        if (stream) next.set(id, stream);
        else next.delete(id);
        return next;
      });
    });
    return () => {
      unsubscribe();
      subscriber.closeAll();
    };
  }, [subscriber]);

  // Start the service on entering the section, and fetch the current picture.
  useEffect(() => {
    void client.invoke('wireless:start').then((result) => {
      if (result.ok) setStatus(result.data);
    });
    void client.invoke('camera:sources').then((result) => {
      if (result.ok) setSources(result.data);
    });
  }, []);

  const phones = status?.phones ?? [];
  const pairingPhone = phones.find((phone) => phone.state === 'pairing' || phone.state === 'authenticating');

  // A pairing that expires or completes must clear the QR code, so the operator is never looking
  // at a code that no longer works.
  useEffect(() => {
    if (!ticket) return;
    const phone = phones.find((candidate) => candidate.sessionId === ticket.sessionId);
    if (!phone || (phone.state !== 'pairing' && phone.state !== 'authenticating')) setTicket(null);
  }, [phones, ticket]);

  const addPhone = useCallback(async () => {
    const created = await createSession.run({ label: `Phone ${(status?.phones.length ?? 0) + 1}` });
    if (created) setTicket(created);
  }, [createSession, status]);

  const wirelessSources = sources.filter((source) => source.isWireless);
  const localSources = sources.filter((source) => !source.isWireless);
  const selectedSource = wirelessSources.find((source) => source.id === selected) ?? wirelessSources[0] ?? null;
  const selectedStream = selectedSource ? (previewStreams.get(selectedSource.id) ?? null) : null;

  return (
    <div className="h-full flex min-h-0">
      {/* ── camera list ───────────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-ink-700 flex flex-col min-h-0">
        <div className="p-3 border-b border-ink-700">
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void addPhone()}
            disabled={createSession.pending || status?.running !== true}
          >
            + Add Phone Camera
          </button>
          {status?.running === false && status.problem === null && (
            <p className="mt-2 text-[11px] text-silver-600">Starting Wireless Camera…</p>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          <ListHeading>Local Cameras</ListHeading>
          {localSources.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-silver-700">
              USB and webcam detection arrives in Phase 6.
            </p>
          ) : (
            localSources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                selected={selected === source.id}
                onSelect={() => setSelected(source.id)}
              />
            ))
          )}

          <ListHeading>Wireless Cameras</ListHeading>
          {wirelessSources.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-silver-700">
              No phones connected. Use Add Phone Camera to pair one.
            </p>
          ) : (
            wirelessSources.map((source) => {
              const phone = phones.find((candidate) => `phone:${candidate.sessionId}` === source.id);
              return (
                <SourceRow
                  key={source.id}
                  source={source}
                  phone={phone}
                  selected={selectedSource?.id === source.id}
                  onSelect={() => setSelected(source.id)}
                />
              );
            })
          )}
        </div>

        {status && <NetworkFooter status={status} />}
      </div>

      {/* ── detail pane ───────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-auto p-5">
        <div className="max-w-3xl space-y-4">
          {createSession.failure && <FailureNotice notice={createSession.failure} />}
          {disconnect.failure && <FailureNotice notice={disconnect.failure} />}

          {status?.problem !== null && status?.problem !== undefined && (
            <FailureNotice
              notice={{
                domain: 'camera',
                code: 'wireless/network',
                message: status.problem,
                remedies: status.remedies,
                severity: 'warning',
                retryable: true,
                id: 'wireless-network',
                occurredAt: new Date().toISOString(),
              }}
              onRetry={() => void client.invoke('wireless:start')}
            />
          )}

          {ticket ? (
            <PairingPanel
              ticket={ticket}
              phone={pairingPhone}
              status={status}
              onCancel={async () => {
                await cancelSession.run({ sessionId: ticket.sessionId });
                setTicket(null);
              }}
              onRegenerate={() => void addPhone()}
            />
          ) : selectedSource ? (
            <PreviewPanel
              source={selectedSource}
              phone={phones.find((candidate) => `phone:${candidate.sessionId}` === selectedSource.id)}
              stream={selectedStream}
              busy={assign.pending || disconnect.pending}
              onGoLive={() => void assign.run({ id: selectedSource.id, assignment: 'live' })}
              onStop={() => void assign.run({ id: selectedSource.id, assignment: 'standby' })}
              onDisconnect={() => {
                const sessionId = selectedSource.id.replace(/^phone:/, '');
                void disconnect.run({ sessionId });
              }}
            />
          ) : (
            <EmptyState
              title="No camera selected"
              description="Pair a phone with Add Phone Camera, then its live preview appears here."
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── pairing ─────────────────────────────────────────────────────────────────────

function PairingPanel({
  ticket,
  phone,
  status,
  onCancel,
  onRegenerate,
}: {
  ticket: PairingTicket;
  phone: WirelessPhone | undefined;
  status: WirelessStatus | null;
  onCancel: () => void;
  onRegenerate: () => void;
}): JSX.Element {
  const remaining = useCountdown(ticket.expiresAt);
  const expired = remaining <= 0;

  return (
    <Panel title="Connect a phone camera">
      <div className="p-5">
        <p className="text-[13px] text-silver-500 mb-5">
          Connect your phone to the same Wi-Fi network, then scan this code.
        </p>

        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0">
            {expired ? (
              <div className="w-[220px] h-[220px] grid place-items-center rounded-lg border border-ink-700 bg-ink-950 text-center px-4">
                <p className="text-[12px] text-silver-600">
                  Pairing session expired.
                  <br />
                  Generate a new code.
                </p>
              </div>
            ) : (
              <QrImage value={ticket.pairingUrl} />
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-4">
            <div>
              <p className="field-label">PIN</p>
              {/*
                Shown here and NOWHERE in the QR code. Photographing the code is not enough —
                someone has to be standing at this monitor. That is the two-factor model.
              */}
              <p className="text-3xl font-bold tracking-[0.2em] timecode text-silver-100">
                {formatPin(ticket.pin)}
              </p>
            </div>

            <div>
              <p className="field-label">Expires in</p>
              <p className={`text-xl font-semibold timecode ${expired ? 'text-status-error' : 'text-silver-200'}`}>
                {formatRemaining(remaining)}
              </p>
            </div>

            <div>
              <p className="field-label">Status</p>
              <p className="flex items-center gap-2 text-[13px] text-silver-300">
                <StatusDot tone={expired ? 'error' : 'ready'} pulse={!expired} />
                {expired
                  ? 'Pairing session expired'
                  : phone?.state === 'authenticating'
                    ? 'Phone entering PIN…'
                    : 'Waiting for phone…'}
              </p>
            </div>

            {status?.lanAddress && (
              <div>
                <p className="field-label">Or open on the phone</p>
                <p className="text-[12px] text-silver-400 selectable break-all">{ticket.displayUrl}</p>
                {status.interfaceName && (
                  <p className="mt-1 text-[11px] text-silver-700">via {status.interfaceName}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* The certificate warning is expected, so it is explained before it happens. */}
        <div className="mt-5 p-3 rounded-lg bg-ink-850 border border-ink-700">
          <p className="text-[12px] font-semibold text-silver-300">
            Your phone will show a security warning the first time.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-silver-600">
            <li>On iPhone: tap “Show Details”, then “visit this website”.</li>
            <li>On Android: tap “Advanced”, then “Proceed”.</li>
            <li>This is only needed once per phone. Video never leaves your network.</li>
          </ul>
        </div>

        <div className="mt-4 flex gap-2">
          {expired ? (
            <button type="button" className="btn-primary" onClick={onRegenerate}>
              Generate new code
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel pairing
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Renders the pairing URL as a QR code using the `qrcode` package. */
function QrImage({ value }: { value: string }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      // High contrast on a dark UI: phone cameras cope far better with a light code.
      color: { dark: '#060D16', light: '#FFFFFF' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (error) {
    return (
      <div className="w-[220px] h-[220px] grid place-items-center rounded-lg border border-status-error/40 bg-ink-950 p-3">
        <p className="text-[11px] text-status-error text-center">
          The QR code could not be generated. Open the address below on the phone instead.
        </p>
      </div>
    );
  }

  return dataUrl ? (
    <img src={dataUrl} alt="Pairing QR code" width={220} height={220} className="rounded-lg" />
  ) : (
    <div className="w-[220px] h-[220px] rounded-lg bg-ink-950 border border-ink-700" />
  );
}

// ── preview ─────────────────────────────────────────────────────────────────────

function PreviewPanel({
  source,
  phone,
  stream,
  busy,
  onGoLive,
  onStop,
  onDisconnect,
}: {
  source: CameraSource;
  phone: WirelessPhone | undefined;
  stream: MediaStream | null;
  busy: boolean;
  onGoLive: () => void;
  onStop: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const state = (phone?.state ?? 'disconnected') as WirelessState;
  const isLive = source.assignment === 'live';

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    // srcObject, never a URL: this is a live MediaStream.
    if (element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);

  return (
    <>
      <Panel
        title={source.name}
        actions={
          isLive ? (
            <span className="flex items-center gap-1.5 px-2 h-5 rounded text-[10px] font-bold tracking-widest uppercase bg-status-live/15 text-status-live border border-status-live">
              <StatusDot tone="live" pulse />
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-silver-500">
              <StatusDot tone={wirelessStateTone(state)} pulse={state === 'reconnecting'} />
              {describeWirelessState(state)}
            </span>
          )
        }
      >
        <div className="p-4">
          <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-ink-700">
            {stream ? (
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                {/* No placeholder image and no simulated frames — if there is no stream, say so. */}
                <p className="text-[12px] text-silver-700 uppercase tracking-[0.18em]">
                  {state === 'reconnecting' ? 'Reconnecting…' : 'No video signal'}
                </p>
              </div>
            )}
            {isLive && stream && (
              <div className="absolute top-3 left-3 px-2 py-1 rounded bg-status-live text-white text-[10px] font-bold tracking-widest">
                ● LIVE
              </div>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Metric label="Resolution" value={source.resolution ? `${source.resolution.width} × ${source.resolution.height}` : '—'} />
            <Metric label="Frame rate" value={source.fps !== null ? `${source.fps} fps` : '—'} />
            {/* Section 20: never invent a latency figure. */}
            <Metric label="Latency" value={source.latencyMs !== null ? `${source.latencyMs} ms` : '—'} />
            <Metric label="Connection" value={source.quality ? titleCase(source.quality) : '—'} />
          </dl>

          {/* Section 19: warn, never auto-disconnect. */}
          {(source.quality === 'poor' || source.quality === 'fair') && (
            <p className="mt-3 text-[12px] text-status-ready">
              Connection quality is {source.quality}. The camera is still usable — move the phone
              closer to the access point if the picture breaks up.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={onGoLive}
              // A camera with no stream cannot go live; that would black the projector.
              disabled={busy || isLive || !stream}
            >
              Go Live
            </button>
            <button type="button" className="btn-secondary" onClick={onStop} disabled={busy || !isLive}>
              Stop
            </button>
            <button type="button" className="btn-ghost text-status-error" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </button>
          </div>

          {phone?.deviceLabel && (
            <p className="mt-3 text-[11px] text-silver-700">
              Paired with {phone.deviceLabel}
              {phone.audioEnabled ? ' · audio on' : ' · audio off'}
            </p>
          )}
        </div>
      </Panel>

      <p className="text-[11px] text-silver-700">
        Switching between front and rear cameras is done on the phone, so the picture swaps without
        renegotiating the connection.
      </p>
    </>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────────

const ListHeading = ({ children }: { children: string }): JSX.Element => (
  <p className="px-4 pt-4 pb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">
    {children}
  </p>
);

function SourceRow({
  source,
  phone,
  selected,
  onSelect,
}: {
  source: CameraSource;
  phone?: WirelessPhone | undefined;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const state = (phone?.state ?? 'disconnected') as WirelessState;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-4 py-2.5 hover:bg-ink-800 transition-colors duration-snap ${selected ? 'bg-ink-750' : ''}`}
    >
      <span className="flex items-center gap-2">
        <StatusDot
          tone={source.assignment === 'live' ? 'live' : wirelessStateTone(state)}
          pulse={source.assignment === 'live' || state === 'reconnecting'}
        />
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] text-silver-200 truncate">{source.name}</span>
          <span className="block text-[11px] text-silver-600 truncate">
            {source.assignment === 'live' ? 'LIVE · ' : ''}
            {describeSource(source)}
          </span>
        </span>
      </span>
    </button>
  );
}

const Metric = ({ label, value }: { label: string; value: string }): JSX.Element => (
  <div className="rounded-md bg-ink-950 border border-ink-700 p-2.5">
    <dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-silver-700">{label}</dt>
    <dd className="mt-1 text-[13px] text-silver-300 timecode">{value}</dd>
  </div>
);

const NetworkFooter = ({ status }: { status: WirelessStatus }): JSX.Element => (
  <div className="shrink-0 border-t border-ink-700 p-3 text-[11px] text-silver-700 space-y-0.5">
    <p className="flex items-center gap-1.5">
      <StatusDot tone={status.running ? 'ok' : 'idle'} />
      {status.running ? 'Wireless Camera ready' : 'Wireless Camera stopped'}
    </p>
    {status.origin && <p className="selectable break-all">{status.origin}</p>}
    <p>
      {status.phones.length} of {status.maxPhones} phones
    </p>
  </div>
);

/** Ticks once a second so the pairing countdown actually counts down. */
function useCountdown(expiresAt: string): number {
  const target = Date.parse(expiresAt);
  const [remaining, setRemaining] = useState(() => Math.max(target - Date.now(), 0));

  useEffect(() => {
    setRemaining(Math.max(target - Date.now(), 0));
    const handle = window.setInterval(() => {
      setRemaining(Math.max(target - Date.now(), 0));
    }, 500);
    return () => window.clearInterval(handle);
  }, [target]);

  return remaining;
}

function formatRemaining(ms: number): string {
  const total = Math.max(Math.ceil(ms / 1000), 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
