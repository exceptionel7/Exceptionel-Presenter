/**
 * EXCEPTIONEL PRESENTER — the phone camera page (Sections 6, 7, 8, 17, 21).
 *
 * Served as strings rather than files so it works identically in `electron-vite dev` and
 * inside a packaged asar, with no asset pipeline and no runtime file reads.
 *
 * NO FRAMEWORK, NO BUILD STEP, NO NETWORK FETCHES. The page must load instantly on a phone
 * that has just tapped through a certificate warning, on a congested church Wi-Fi, with no
 * internet access at all. Plain HTML and one script is the right tool.
 *
 * TESTING STATUS: the page is served and its structure is verified by tests. The camera and
 * WebRTC behaviour inside it can only be verified on a real phone — see the milestone report.
 */

export const PHONE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- viewport-fit + user-scalable=no: this is an appliance, not a document. Pinch-zooming a
     camera control mid-service is never what the operator wants. -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0A1421">
<meta name="referrer" content="no-referrer">
<!-- Keeps iOS from turning the PIN digits into tappable phone links. -->
<meta name="format-detection" content="telephone=no">
<title>Exceptionel Presenter — Wireless Camera</title>
<link rel="stylesheet" href="/camera.css">
</head>
<body>
<main id="app">
  <header class="brand">
    <svg class="mark" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="s" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#FFFFFF"/><stop offset="45%" stop-color="#E4EAF2"/>
          <stop offset="100%" stop-color="#8496AC"/>
        </linearGradient>
        <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3FB0FA"/><stop offset="100%" stop-color="#1F5FE8"/>
        </linearGradient>
      </defs>
      <path fill="url(#s)" d="M330 54 H452 L392 130 H236a56 56 0 0 0-56 56V326a56 56 0 0 0 56 56H392L452 458H330a150 150 0 0 1-150-150V204A150 150 0 0 1 330 54Z"/>
      <path fill="url(#b)" d="M262 168 L404 256 L262 344 Z"/>
    </svg>
    <div class="titles">
      <h1>EXCEPTIONEL</h1>
      <p>WIRELESS CAMERA</p>
    </div>
  </header>

  <!-- STEP 1: PIN entry. The PIN is deliberately not in the QR code. -->
  <section id="step-pair" class="card">
    <h2>Enter the PIN</h2>
    <p class="hint">Type the six digits shown on the computer running Exceptionel Presenter.</p>
    <input id="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
           maxlength="6" placeholder="000000" aria-label="Six digit PIN">
    <button id="pair" class="primary">CONNECT</button>
    <p id="pair-error" class="error" role="alert" hidden></p>
  </section>

  <!-- STEP 2: camera control. -->
  <section id="step-camera" class="card" hidden>
    <div id="status" class="status status-off">
      <span class="dot"></span><span id="status-text">CAMERA OFF</span>
    </div>

    <div class="stage">
      <!-- muted is required for autoplay; playsinline stops iOS going fullscreen. -->
      <video id="preview" autoplay playsinline muted></video>
      <div id="live-badge" class="live-badge" hidden>● CAMERA LIVE</div>
    </div>

    <div class="controls">
      <button id="start" class="primary">START CAMERA</button>
      <button id="switch" class="secondary" disabled>SWITCH CAMERA</button>
      <button id="audio" class="secondary" disabled>UNMUTE AUDIO</button>
      <button id="stop" class="danger" disabled>STOP CAMERA</button>
    </div>

    <dl id="stats" class="stats">
      <div><dt>Resolution</dt><dd id="stat-res">—</dd></div>
      <div><dt>Frame rate</dt><dd id="stat-fps">—</dd></div>
      <div><dt>Connection</dt><dd id="stat-conn">—</dd></div>
    </dl>

    <p id="camera-error" class="error" role="alert" hidden></p>
  </section>

  <footer class="foot">
    <p>Video goes straight to this computer over Wi-Fi. It is never uploaded or recorded.</p>
  </footer>
</main>
<script src="/camera.js"></script>
</body>
</html>
`;

export const PHONE_PAGE_CSS = `:root {
  --ink-950: #060D16; --ink-900: #0A1421; --ink-800: #132132; --ink-700: #1F3348;
  --silver-100: #FFFFFF; --silver-300: #D8E1EC; --silver-500: #94A5BA; --silver-600: #6E8299;
  --signal: #1E8FEF; --live: #FF2D46; --ok: #22C55E;
  color-scheme: dark;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; min-height: 100%; background: var(--ink-900); }
body {
  color: var(--silver-300);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  /* Respects the notch and the home indicator. */
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  -webkit-user-select: none; user-select: none;
}
#app { max-width: 560px; margin: 0 auto; padding: 20px 16px 32px; }

.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.mark { width: 34px; height: 34px; flex: none; }
.titles h1 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: .14em; color: var(--silver-100); }
.titles p { margin: 2px 0 0; font-size: 10px; font-weight: 600; letter-spacing: .3em; color: var(--silver-600); }

.card {
  background: linear-gradient(180deg, var(--ink-800), var(--ink-900));
  border: 1px solid var(--ink-700); border-radius: 14px; padding: 18px; margin-bottom: 16px;
}
.card h2 { margin: 0 0 6px; font-size: 17px; color: var(--silver-100); }
.hint { margin: 0 0 14px; font-size: 13px; color: var(--silver-500); }

#pin {
  width: 100%; height: 60px; text-align: center; letter-spacing: .4em; font-size: 28px;
  font-variant-numeric: tabular-nums; color: var(--silver-100); background: var(--ink-950);
  border: 1px solid var(--ink-700); border-radius: 10px; margin-bottom: 12px;
  -webkit-user-select: text; user-select: text;
}
#pin:focus { outline: 2px solid var(--signal); outline-offset: 2px; }

button {
  width: 100%; min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700;
  letter-spacing: .06em; border: 1px solid transparent; margin-bottom: 10px;
  transition: opacity .12s, background .12s;
}
button:active { opacity: .75; }
button:disabled { opacity: .35; }
.primary { background: linear-gradient(135deg, #2BA3F7, #1F5FE8); color: #fff; }
.secondary { background: var(--ink-800); color: var(--silver-300); border-color: var(--ink-700); }
.danger { background: transparent; color: var(--live); border-color: var(--live); }

.status {
  display: flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 800;
  letter-spacing: .14em; margin-bottom: 14px;
}
.status .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.status-off { color: var(--silver-600); } .status-off .dot { background: var(--silver-600); }
.status-ready { color: var(--ok); } .status-ready .dot { background: var(--ok); }
.status-live { color: var(--live); } .status-live .dot { background: var(--live); animation: pulse 1.5s infinite; }
@keyframes pulse { 50% { opacity: .35; } }

.stage {
  position: relative; aspect-ratio: 16/9; background: #000; border-radius: 10px;
  overflow: hidden; margin-bottom: 14px; border: 1px solid var(--ink-700);
}
#preview { width: 100%; height: 100%; object-fit: cover; display: block; }
.live-badge {
  position: absolute; top: 10px; left: 10px; background: var(--live); color: #fff;
  font-size: 11px; font-weight: 800; letter-spacing: .1em; padding: 5px 9px; border-radius: 6px;
}

.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0 0; }
.stats div { background: var(--ink-950); border: 1px solid var(--ink-700); border-radius: 8px; padding: 9px; }
.stats dt { font-size: 9px; font-weight: 700; letter-spacing: .12em; color: var(--silver-600); text-transform: uppercase; }
.stats dd { margin: 4px 0 0; font-size: 13px; color: var(--silver-300); font-variant-numeric: tabular-nums; }

.error {
  margin: 12px 0 0; padding: 11px; border-radius: 8px; font-size: 13px;
  background: rgba(255,45,70,.1); border: 1px solid rgba(255,45,70,.4); color: #FFC9D0;
}
.error ul { margin: 8px 0 0; padding-left: 18px; }
.foot p { font-size: 11px; color: var(--silver-600); text-align: center; margin: 0; }

/* Landscape: the preview takes the height, controls sit beside it. */
@media (orientation: landscape) and (max-height: 520px) {
  #app { max-width: none; display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; align-items: start; }
  .brand, .foot { grid-column: 1 / -1; margin-bottom: 8px; }
  .stage { margin-bottom: 0; }
  .stats { grid-template-columns: 1fr; }
}
`;

export const PHONE_PAGE_JS = String.raw`/*
 * EXCEPTIONEL PRESENTER — phone camera client.
 *
 * The phone is the ANSWERER: the desktop creates the offer. That ordering matters because the
 * desktop knows which window should own the connection, and it avoids both ends trying to
 * negotiate at once (glare).
 *
 * No STUN or TURN server is configured, deliberately. Both devices are on the same LAN, so
 * host candidates are sufficient — which is what keeps the video path local and free of any
 * cloud dependency.
 */
'use strict';

(function () {
  var params = new URLSearchParams(location.search);
  var sessionId = params.get('s') || '';
  var pairingToken = params.get('t') || '';

  var pc = null;
  var stream = null;
  var facing = 'environment'; // rear camera by default: better suited to live production
  var audioOn = false;
  var connected = false;
  var abortStream = null;
  var statsTimer = null;

  var el = function (id) { return document.getElementById(id); };

  // ── UI helpers ────────────────────────────────────────────────────────────────
  function setStatus(kind, text) {
    var node = el('status');
    node.className = 'status status-' + kind;
    el('status-text').textContent = text;
    el('live-badge').hidden = kind !== 'live';
  }

  function showError(target, message, checks) {
    var node = el(target);
    node.hidden = false;
    node.textContent = message;
    if (checks && checks.length) {
      var list = document.createElement('ul');
      checks.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      });
      node.appendChild(list);
    }
  }

  function clearError(target) {
    var node = el(target);
    node.hidden = true;
    node.textContent = '';
  }

  /*
   * Section 7 and 20: every getUserMedia failure gets its own explanation, because the fixes
   * are genuinely different. "Allow camera access" is useless advice when the real problem is
   * that another app holds the device.
   */
  function describeCameraError(error) {
    var name = (error && error.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        message: 'Camera permission was denied.',
        checks: [
          'Tap the address bar and allow camera access for this page.',
          'On iPhone: Settings > Safari > Camera > Allow.',
          'On Android: tap the lock icon > Permissions > Camera.',
          'Then tap START CAMERA again.'
        ]
      };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        message: 'The camera is already in use by another app.',
        checks: ['Close other camera apps, then tap START CAMERA again.']
      };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return { message: 'No camera was found on this phone.', checks: [] };
    }
    if (name === 'OverconstrainedError') {
      return {
        message: 'This phone does not support the requested video settings.',
        checks: ['Tap START CAMERA again — a lower resolution will be used.']
      };
    }
    return {
      message: 'The camera could not be started.' + (name ? ' (' + name + ')' : ''),
      checks: ['Reload this page and try again.']
    };
  }

  // ── pairing ───────────────────────────────────────────────────────────────────
  el('pair').addEventListener('click', function () {
    var pin = (el('pin').value || '').replace(/\D/g, '');
    if (pin.length !== 6) {
      showError('pair-error', 'Enter all six digits of the PIN.');
      return;
    }
    clearError('pair-error');
    el('pair').disabled = true;
    el('pair').textContent = 'CONNECTING…';

    fetch('/pair/claim?s=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        token: pairingToken,
        pin: pin,
        deviceLabel: describeDevice()
      })
    })
      .then(function (response) {
        return response.json().then(function (body) { return { status: response.status, body: body }; });
      })
      .then(function (result) {
        if (result.status !== 200) {
          var failure = new Error((result.body && result.body.error) || 'Pairing failed.');
          failure.reason = result.body && result.body.reason;
          throw failure;
        }
        el('step-pair').hidden = true;
        el('step-camera').hidden = false;
        openSignalStream();
      })
      .catch(function (error) {
        /*
         * Remedies are chosen from the server's failure reason rather than being generic.
         *
         * The distinction that matters most is a DEAD LINK versus a WRONG PIN. A page left open
         * from an earlier run still holds its old token in the URL, and pairing sessions are held
         * in memory only - so restarting Exceptionel Presenter invalidates every QR code. Telling
         * someone to check the PIN in that situation sends them round in circles, because no PIN
         * will ever work.
         *
         * NOTE: no backticks anywhere in this file's script. It is a String.raw template, so a
         * backtick terminates it and an escaped one would survive into the served JavaScript.
         */
        var reason = error.reason;
        var deadLink =
          reason === 'invalid-link' || reason === 'expired' || reason === 'revoked' || reason === 'already-claimed';

        if (deadLink) {
          // Hide the PIN field: there is nothing useful to type until a new code is scanned.
          el('pin').hidden = true;
          el('pair').hidden = true;
          showError('pair-error', error.message || 'This pairing code is no longer valid.', [
            'Scan the CURRENT QR code shown in Exceptionel Presenter.',
            'Codes expire after two minutes, and restarting the application creates new ones.',
            'Do not reuse a page left open from an earlier attempt — close this tab and scan again.'
          ]);
          return;
        }

        if (reason === 'too-many-attempts') {
          el('pin').hidden = true;
          el('pair').hidden = true;
          showError('pair-error', error.message || 'Too many incorrect attempts.', [
            'Ask the operator to generate a new QR code, then scan it.'
          ]);
          return;
        }

        showError('pair-error', error.message || 'Pairing failed.', [
          'Check the six digits shown on the computer screen.',
          'The PIN is on the computer, not in the QR code.'
        ]);
      })
      .then(function () {
        el('pair').disabled = false;
        el('pair').textContent = 'CONNECT';
      });
  });

  el('pin').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') el('pair').click();
  });

  function describeDevice() {
    var ua = navigator.userAgent;
    var os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Phone';
    var browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : 'Safari';
    return os + ' (' + browser + ')';
  }

  // ── signaling ─────────────────────────────────────────────────────────────────
  function openSignalStream() {
    /*
     * EventSource rather than streaming fetch: it reconnects on its own after a Wi-Fi blip
     * and has far more dependable support on iOS Safari. It authenticates by the HttpOnly
     * cookie set during pairing, so no token is ever placed in this URL.
     */
    var source = new EventSource('/signal/stream?s=' + encodeURIComponent(sessionId));
    abortStream = function () { source.close(); };

    source.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      handleSignal(message);
    };

    source.onerror = function () {
      // EventSource retries automatically; only report once the camera was already running,
      // so a transient blip does not alarm the user.
      if (connected) setStatus('ready', 'RECONNECTING…');
    };
  }

  function post(message) {
    return fetch('/signal/send?s=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message)
    });
  }

  function handleSignal(message) {
    if (!message || !message.kind) return;

    if (message.kind === 'offer') {
      if (!pc) return;
      pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer).then(function () { return answer; }); })
        .then(function (answer) { return post({ kind: 'answer', sdp: answer.sdp }); })
        .catch(function (error) { showError('camera-error', 'Could not negotiate video: ' + error.message); });
      return;
    }

    if (message.kind === 'ice' && pc && message.candidate) {
      pc.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid || null,
        sdpMLineIndex: typeof message.sdpMLineIndex === 'number' ? message.sdpMLineIndex : null
      }).catch(function () { /* a rejected candidate is survivable */ });
      return;
    }

    if (message.kind === 'bye') {
      stopCamera('The operator ended this camera session.');
    }
  }

  // ── camera ────────────────────────────────────────────────────────────────────
  function constraintsFor(mode) {
    /*
     * Ideal rather than exact, so a phone that cannot manage 1080p30 degrades instead of
     * throwing OverconstrainedError. Section 7: never assume a device supports a resolution.
     */
    return {
      video: {
        facingMode: { ideal: mode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: audioOn ? { echoCancellation: true, noiseSuppression: true } : false
    };
  }

  el('start').addEventListener('click', function () { startCamera(); });

  function startCamera() {
    clearError('camera-error');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('camera-error', 'This browser cannot access the camera.', [
        'The page must be opened over https.',
        'Use Safari on iPhone or Chrome on Android.'
      ]);
      return;
    }

    el('start').disabled = true;
    setStatus('off', 'STARTING…');

    navigator.mediaDevices
      .getUserMedia(constraintsFor(facing))
      .then(function (media) {
        stream = media;
        el('preview').srcObject = media;
        setStatus('ready', 'CAMERA READY');

        el('switch').disabled = false;
        el('audio').disabled = false;
        el('stop').disabled = false;
        el('start').disabled = true;

        var track = media.getVideoTracks()[0];
        var settings = (track && track.getSettings && track.getSettings()) || {};
        el('stat-res').textContent = settings.width && settings.height ? settings.width + '×' + settings.height : '—';
        el('stat-fps').textContent = settings.frameRate ? Math.round(settings.frameRate) + ' fps' : '—';

        // A track can end on its own — the OS revoking access, or another app taking the
        // camera. Without this the page would claim to be live while sending nothing.
        if (track) {
          track.addEventListener('ended', function () { stopCamera('The camera stopped unexpectedly.'); });
        }

        createPeer();

        return post({
          kind: 'ready',
          width: settings.width || null,
          height: settings.height || null,
          frameRate: settings.frameRate || null,
          hasAudio: audioOn
        });
      })
      .catch(function (error) {
        el('start').disabled = false;
        setStatus('off', 'CAMERA OFF');
        var described = describeCameraError(error);
        showError('camera-error', described.message, described.checks);
      });
  }

  function createPeer() {
    // No iceServers: both devices are on the same LAN, so host candidates suffice and nothing
    // reaches out to the internet.
    pc = new RTCPeerConnection({ iceServers: [] });

    stream.getTracks().forEach(function (track) { pc.addTrack(track, stream); });

    pc.onicecandidate = function (event) {
      if (!event.candidate) return;
      post({
        kind: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    };

    pc.onconnectionstatechange = function () {
      var state = pc.connectionState;
      post({ kind: 'state', state: state });
      el('stat-conn').textContent = state;

      if (state === 'connected') {
        connected = true;
        setStatus('live', 'CAMERA LIVE');
        startStats();
      } else if (state === 'connecting') {
        setStatus('ready', 'CONNECTING…');
      } else if (state === 'disconnected') {
        setStatus('ready', 'RECONNECTING…');
      } else if (state === 'failed' || state === 'closed') {
        connected = false;
        setStatus('off', 'CAMERA OFF');
        stopStats();
      }
    };
  }

  function startStats() {
    stopStats();
    statsTimer = setInterval(function () {
      if (!pc || !pc.getStats) return;
      pc.getStats(null).then(function (report) {
        report.forEach(function (entry) {
          if (entry.type === 'outbound-rtp' && entry.kind === 'video' && entry.framesPerSecond) {
            el('stat-fps').textContent = Math.round(entry.framesPerSecond) + ' fps';
          }
        });
      });
    }, 2000);
  }

  function stopStats() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  // ── switch camera (Section 8) ──────────────────────────────────────────────────
  el('switch').addEventListener('click', function () {
    if (!stream) return;
    facing = facing === 'environment' ? 'user' : 'environment';
    el('switch').disabled = true;

    /*
     * The OLD TRACK IS STOPPED FIRST. Many phones — iOS especially — will not open the second
     * camera while the first is still held, and leaving both running drains the battery and
     * can hand the encoder two live tracks. Section 8 requires this explicitly.
     */
    var old = stream.getVideoTracks()[0];
    if (old) old.stop();

    navigator.mediaDevices
      .getUserMedia(constraintsFor(facing))
      .then(function (media) {
        var next = media.getVideoTracks()[0];

        // replaceTrack keeps the peer connection intact, so the picture swaps without
        // renegotiating and the desktop never sees a disconnect.
        var sender = pc && pc.getSenders().filter(function (s) { return s.track && s.track.kind === 'video'; })[0];
        if (sender && next) sender.replaceTrack(next);

        if (old) stream.removeTrack(old);
        if (next) stream.addTrack(next);
        el('preview').srcObject = stream;

        var settings = (next && next.getSettings && next.getSettings()) || {};
        el('stat-res').textContent = settings.width && settings.height ? settings.width + '×' + settings.height : '—';
        el('switch').disabled = false;
      })
      .catch(function (error) {
        // Restore the previous facing so the label matches what is actually running.
        facing = facing === 'environment' ? 'user' : 'environment';
        el('switch').disabled = false;
        var described = describeCameraError(error);
        showError('camera-error', 'Could not switch camera. ' + described.message, described.checks);
      });
  });

  // ── audio (Section 19) ────────────────────────────────────────────────────────
  el('audio').addEventListener('click', function () {
    audioOn = !audioOn;
    el('audio').textContent = audioOn ? 'MUTE AUDIO' : 'UNMUTE AUDIO';

    var tracks = stream ? stream.getAudioTracks() : [];
    if (audioOn && tracks.length === 0) {
      // Audio was not requested initially, so acquire it now and add it to the connection.
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(function (media) {
          var track = media.getAudioTracks()[0];
          if (track && stream) { stream.addTrack(track); if (pc) pc.addTrack(track, stream); }
        })
        .catch(function () {
          audioOn = false;
          el('audio').textContent = 'UNMUTE AUDIO';
          showError('camera-error', 'Microphone permission was denied.');
        });
      return;
    }
    tracks.forEach(function (track) { track.enabled = audioOn; });
  });

  // ── stop (Section 17) ─────────────────────────────────────────────────────────
  el('stop').addEventListener('click', function () { stopCamera(null); });

  function stopCamera(reason) {
    /*
     * Section 17: after STOP the phone must not keep transmitting. Every track is stopped,
     * which turns off the OS camera indicator, and the peer connection is closed so nothing
     * can resume without an explicit START.
     */
    stopStats();
    connected = false;

    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      stream = null;
    }
    el('preview').srcObject = null;

    if (pc) {
      try { post({ kind: 'bye', reason: reason || 'Stopped on phone' }); } catch (error) { /* best effort */ }
      pc.close();
      pc = null;
    }

    setStatus('off', 'CAMERA OFF');
    el('start').disabled = false;
    el('switch').disabled = true;
    el('audio').disabled = true;
    el('stop').disabled = true;
    el('stat-res').textContent = '—';
    el('stat-fps').textContent = '—';
    el('stat-conn').textContent = '—';

    if (reason) showError('camera-error', reason, []);
  }

  // Closing the tab or locking the phone must release the camera, not leave it held.
  window.addEventListener('pagehide', function () {
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    if (abortStream) abortStream();
  });

  // ── entry ─────────────────────────────────────────────────────────────────────
  if (!sessionId || !pairingToken) {
    el('step-pair').hidden = true;
    showError('pair-error', 'This link is incomplete. Scan the QR code shown in Exceptionel Presenter.');
    el('pair-error').hidden = false;
  } else {
    el('pin').focus();
  }
})();
`;
