import { createHash } from 'crypto';

// The call script: what a page runs while it is in a call. It is loaded by
// the page script the first time someone presses a call button (see "calls"
// in src/pagescript.ts), from its own URL on the same terms as page.js, so a
// page that never joins a call never downloads it.
//
// Its WebRTC half is a port of commonroom's (~/src/concept-collection/
// commonroom, src/p2p/peer.ts and network.ts), with the signaling moved from
// Nostr relays to the workspace itself:
//
//  - Every page in a call connects to every other: a full mesh, carrying one
//    audio and one video track each way and a small data channel for mute
//    notices and the call's shared quality setting. The page with the smaller
//    id makes the single offer, so the two sides never both offer at once,
//    and nothing is renegotiated afterwards: a changed microphone or a screen
//    share replaces a track in place.
//  - Who is in the call is the workspace's to say. Its roster arrives on the
//    page's own event stream, and replaces commonroom's presence
//    announcements; offers, answers, and ICE candidates go up as requests
//    addressed to one page and come down that page's stream.
//  - The ICE servers, a TURN relay among them where the workspace has one,
//    come from the workspace when joining (src/ice.ts), and are asked for
//    again before their credentials run out.
//
// Everyone joins with microphone and camera off, as in commonroom: the
// devices are opened on joining, so the browser asks for them then, and
// turned on by their buttons.
//
// Unlike page.js this is written in the JavaScript of the browsers that can
// make calls at all (classes, async functions), since it is a port of
// TypeScript classes and reads best kept close to them.
//
// What is drawn is one element, the dock. In the call's own room it sits
// under the room's header as a strip of small tiles; anywhere else it floats
// in a corner, small, and can be dragged; and either can be expanded to fill
// the page and collapsed again. The page script parks the dock outside the
// page while it swaps one page for the next and asks it to place itself
// afterwards, so the call and its video go on through the move.

const CALL_JS = `
(function () {
'use strict';

// ---- settings ----
// The call's video quality: one setting for the whole call, changed by
// anyone in it, and applied by each page to its own outgoing video. In a mesh
// each page uploads a copy to every other, so the presets are ceilings.
const QUALITIES = ['low', 'medium', 'high', 'auto'];
const QUALITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', auto: 'Automatic' };
const QUALITY_PARAMS = {
  auto: {},
  high: { maxBitrate: 2500000, maxFramerate: 30 },
  medium: { maxBitrate: 800000, scaleResolutionDownBy: 2, maxFramerate: 24 },
  low: { maxBitrate: 200000, scaleResolutionDownBy: 4, maxFramerate: 15 }
};

// A connection can survive a brief network blip: 'disconnected' often
// recovers by itself, so it is torn down only if it lasts this long.
const DISCONNECT_GRACE_MS = 5000;
// A connection that has not opened after this long is torn down and made
// again; an offer can be lost (the other page's stream was reconnecting).
const CONNECT_RETRY_MS = 15000;
const RETRY_TICK_MS = 5000;
// A connected page missing from the roster is kept this long before it is
// dropped: after a restart of the workspace the pages join again one by one,
// and each roster until the last is missing some who are still here. A page
// that really left says goodbye over the connection, or its connection fails.
const ROSTER_ABSENCE_MS = 45000;
// Fresh relay credentials are asked for this long before the old ones lapse.
const ICE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// How loud, as RMS of the samples, counts as speaking, and for how long after.
const SPEAKING_LEVEL = 0.025;
const SPEAKING_HOLD_MS = 500;

function stored(key) {
  try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}
const DEVICE_KEYS = { audio: 'dango.call.mic', video: 'dango.call.camera', speaker: 'dango.call.speaker' };

// ---- one connection ----
// Ported from commonroom's peer.ts: an RTCPeerConnection to one other page,
// with the local tracks and one data channel, "control".
class Peer {
  constructor(initiator, localStream, iceServers) {
    this.initiator = initiator;
    this.pc = new RTCPeerConnection({ iceServers: iceServers });
    this.channel = null;
    this.outbox = [];
    this.handlers = {};
    this.pendingCandidates = [];
    this.disconnectTimer = null;
    this.closed = false;
    // Both sides add their tracks up front: the initiator's one offer then
    // covers all media, and the answerer's tracks ride back in the answer.
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);
    this.pc.ontrack = (e) => { if (e.streams[0] && this.handlers.track) this.handlers.track(e.streams[0]); };
    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.handlers.signal) this.handlers.signal({ type: 'candidate', candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') {
        this.clearDisconnectTimer();
        if (this.handlers.connect) this.handlers.connect();
      } else if (s === 'failed' || s === 'closed') {
        this.destroy();
      } else if (s === 'disconnected') {
        this.clearDisconnectTimer();
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.connectionState !== 'connected') this.destroy();
        }, DISCONNECT_GRACE_MS);
      }
    };
    if (initiator) {
      this.setupChannel(this.pc.createDataChannel('control'));
      this.pc.onnegotiationneeded = () => { this.makeOffer(); };
    } else {
      this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
    }
  }
  setHandlers(h) { Object.assign(this.handlers, h); }
  clearDisconnectTimer() {
    if (this.disconnectTimer !== null) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
  }
  setupChannel(channel) {
    this.channel = channel;
    const flush = () => { for (const d of this.outbox.splice(0)) channel.send(d); };
    if (channel.readyState === 'open') flush();
    else channel.onopen = flush;
    channel.onclose = () => this.destroy();
    channel.onmessage = (e) => { if (typeof e.data === 'string' && this.handlers.data) this.handlers.data(e.data); };
  }
  async makeOffer() {
    if (this.closed) return;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      if (this.handlers.signal) this.handlers.signal({ type: 'offer', sdp: this.pc.localDescription.sdp });
    } catch (e) {}
  }
  get hasRemote() { return !!this.pc.remoteDescription; }
  async signal(sig) {
    if (this.closed) return;
    try {
      if (sig.type === 'candidate') {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(sig.candidate);
        else this.pendingCandidates.push(sig.candidate);
        return;
      }
      if (sig.type === 'offer') {
        if (this.initiator) return;
        await this.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
        await this.flushCandidates();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        if (this.handlers.signal) this.handlers.signal({ type: 'answer', sdp: this.pc.localDescription.sdp });
        return;
      }
      if (sig.type === 'answer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        await this.flushCandidates();
      }
    } catch (e) {}
  }
  async flushCandidates() {
    for (const c of this.pendingCandidates.splice(0)) {
      try { await this.pc.addIceCandidate(c); } catch (e) {}
    }
  }
  send(data) {
    if (this.channel && this.channel.readyState === 'open') this.channel.send(data);
    else if (!this.closed) this.outbox.push(data);
  }
  // Swap an outgoing track in place (camera and screen, a new device). A
  // same-kind replaceTrack does not renegotiate, so no signaling is needed.
  async replaceTrack(kind, track) {
    if (this.closed) return false;
    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (!sender) return false;
    try { await sender.replaceTrack(track); return true; } catch (e) { return false; }
  }
  // Cap (or uncap) the outgoing video; an undefined field clears that cap.
  async setVideoParameters(opts) {
    if (this.closed) return false;
    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return false;
    const params = sender.getParameters();
    const enc = params.encodings && params.encodings[0];
    if (!enc) return false;
    for (const k of ['maxBitrate', 'scaleResolutionDownBy', 'maxFramerate']) {
      if (opts[k] === undefined) delete enc[k];
      else enc[k] = opts[k];
    }
    if (opts.degradationPreference === undefined) delete params.degradationPreference;
    else params.degradationPreference = opts.degradationPreference;
    try { await sender.setParameters(params); return true; } catch (e) { return false; }
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearDisconnectTimer();
    try { if (this.channel) this.channel.close(); } catch (e) {}
    try { this.pc.close(); } catch (e) {}
    if (this.handlers.close) this.handlers.close();
  }
}

// ---- signals, through the workspace ----
// A connection's signals go to the other page in order, gathered a moment so
// a burst of ICE candidates is one request rather than twenty.
class Outbox {
  constructor(call, to) {
    this.call = call;
    this.to = to;
    this.queue = [];
    this.busy = false;
    this.timer = null;
    this.closed = false;
  }
  close() {
    this.closed = true;
    this.queue = [];
  }
  push(sig) {
    if (this.closed) return;
    this.queue.push(sig);
    if (!this.busy && this.timer === null) this.timer = setTimeout(() => this.flush(), 25);
  }
  async flush() {
    this.timer = null;
    if (this.busy || this.closed || !this.queue.length || this.call.phase === 'left') return;
    this.busy = true;
    const batch = this.queue.splice(0, 64);
    // A batch that does not arrive is not sent again: the connection it was
    // for stalls, and is made again (see CONNECT_RETRY_MS).
    try { await this.call.post('signal', { to: this.to, signals: batch }); } catch (e) {}
    this.busy = false;
    if (this.queue.length) this.flush();
  }
}

function validSignal(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.type === 'offer' || s.type === 'answer') return typeof s.sdp === 'string';
  return s.type === 'candidate' && !!s.candidate && typeof s.candidate === 'object';
}

// ---- who is speaking ----
// Each stream's audio through an analyser, its level read a few times a
// second. Someone is speaking while their level is over a threshold, and
// for a moment after, so the mark does not flicker between words.
class Levels {
  constructor(onChange) {
    this.onChange = onChange;
    this.ctx = null;
    this.nodes = new Map();
    this.state = new Map();
    this.timer = null;
    this.buf = new Float32Array(1024);
  }
  start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { return; }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.timer = setInterval(() => this.tick(), 150);
  }
  watch(id, stream) {
    const track = stream ? stream.getAudioTracks()[0] : null;
    const cur = this.nodes.get(id);
    if (cur && cur.track === track) return;
    this.unwatch(id);
    if (!this.ctx || !track) return;
    try {
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      this.nodes.set(id, { track: track, src: src, an: an, until: 0 });
    } catch (e) {}
  }
  unwatch(id) {
    const n = this.nodes.get(id);
    if (n) {
      try { n.src.disconnect(); } catch (e) {}
      this.nodes.delete(id);
    }
    if (this.state.get(id)) { this.state.delete(id); this.onChange(id, false); }
  }
  tick() {
    const now = Date.now();
    for (const [id, n] of this.nodes) {
      n.an.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      if (Math.sqrt(sum / this.buf.length) > SPEAKING_LEVEL && n.track.enabled) n.until = now + SPEAKING_HOLD_MS;
      const on = now < n.until;
      if (!!this.state.get(id) !== on) { this.state.set(id, on); this.onChange(id, on); }
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const id of Array.from(this.nodes.keys())) this.unwatch(id);
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

// ---- media ----
function deviceConstraint(kind) {
  const c = kind === 'video'
    ? { width: { ideal: 1280 }, height: { ideal: 720 } }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const id = stored(DEVICE_KEYS[kind]);
  if (id) c.deviceId = { ideal: id };
  return c;
}

// Why a device did not come up, with the error's name, since "permission
// denied" and "another app has the camera" need different fixes.
function mediaErrorMessage(what, err) {
  const name = err && typeof err.name === 'string' ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Your ' + what + ' is blocked for this workspace. Allow it in the browser (the icon at the left of the address bar) and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No ' + what + ' was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your ' + what + ' could not be started; another app may be using it (' + name + ').';
    default:
      return 'Your ' + what + ' could not be used' + (name ? ' (' + name + ')' : '') + '.';
  }
}

// A black frame, sent in place of a camera the page does not have, so that
// every connection carries one audio and one video track.
function blackVideoTrack() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
  return canvas.captureStream(2).getVideoTracks()[0];
}

const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !matchMedia('(pointer: coarse)').matches;
const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// ---- drawing ----
function svg(paths) {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
const ICONS = {
  mic: svg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4"/><path d="M8 23h8"/>'),
  micOff: svg('<path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><path d="M12 19v4"/><path d="M8 23h8"/>'),
  video: svg('<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
  videoOff: svg('<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><path d="M1 1l22 22"/>'),
  screen: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  collapse: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  leave: svg('<path d="M10.7 13.3a13 13 0 0 0 2.8 2.1l1.6-1.6a1.5 1.5 0 0 1 1.6-.4 11 11 0 0 0 3.4.6 1.5 1.5 0 0 1 1.5 1.5v2.9a1.5 1.5 0 0 1-1.5 1.5A18.5 18.5 0 0 1 2.6 4.4 1.5 1.5 0 0 1 4.1 2.9H7a1.5 1.5 0 0 1 1.5 1.5c0 1.2.2 2.3.6 3.4a1.5 1.5 0 0 1-.4 1.6L7.1 11"/><path d="M22 2L2 22"/>'),
  x: svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>')
};

// Drawn again only when it changes: the dock is redrawn whenever someone
// starts or stops speaking, and a control being replaced under the pointer
// would flicker.
function setHtml(el, html) {
  if (el.dangoHtml !== html) { el.innerHTML = html; el.dangoHtml = html; }
}

function controlButton(act, label) {
  return '<button type="button" class="call-ctl" data-call-act="' + act + '" title="' + label + '" aria-label="' + label + '"></button>';
}

// ---- the call ----
class Call {
  constructor(room, title) {
    this.room = room;
    this.title = title;
    this.phase = 'joining';
    this.callId = null;
    this.ice = null;
    this.iceTimer = null;
    this.retryTimer = null;
    this.roster = new Map();
    this.pendingRoster = null;
    this.pendingSignals = [];
    this.conns = new Map();
    this.localStream = null;
    this.screenStream = null;
    this.micAvailable = false;
    this.camAvailable = false;
    this.audioMuted = true;
    this.videoMuted = true;
    this.placeholderCtx = null;
    this.settings = { videoQuality: 'medium' };
    this.settingsMeta = {};
    this.notice = '';
    this.full = false;
    this.kind = '';
    this.spotlight = null;
    this.lastSpeaker = null;
    this.speaking = new Set();
    this.speaker = stored(DEVICE_KEYS.speaker);
    this.miniPos = null;
    this.tiles = new Map();
    // Everyone this page has seen in the call, for the name and face of a
    // connection kept while its page is missing from the roster.
    this.known = new Map();
    this.streamSeen = true;
    this.levels = new Levels((id, on) => {
      if (on) this.speaking.add(id); else this.speaking.delete(id);
      if (on && id !== 'self') this.lastSpeaker = id;
      this.render();
    });
    this.el = null;
  }

  // ---- joining and leaving ----
  async start() {
    this.buildDock();
    this.place();
    this.levels.start();
    const media = await this.acquireMedia();
    if (this.phase === 'left') { for (const t of media.stream.getTracks()) t.stop(); return; }
    this.localStream = media.stream;
    this.micAvailable = media.mic;
    this.camAvailable = media.cam;
    if (!media.mic && !media.cam) this.notice = mediaErrorMessage('camera and microphone', media.camError) + ' You are in the call; their buttons will try again.';
    else if (!media.cam) this.notice = mediaErrorMessage('camera', media.camError) + ' The camera button will try again.';
    else if (!media.mic) this.notice = mediaErrorMessage('microphone', media.micError) + ' The microphone button will try again.';
    for (const t of media.stream.getTracks()) t.enabled = false;
    this.levels.watch('self', this.localStream);
    this.render();
    let r;
    try {
      r = await this.post('join', {});
    } catch (e) {
      if (this.phase === 'left') return;
      window.alert('The call could not be joined: ' + e.message);
      this.leave(false);
      return;
    }
    if (this.phase === 'left') { this.post('leave', {}).catch(() => {}); return; }
    this.callId = r.call;
    this.setIce(r.ice);
    this.phase = 'in';
    if (this.pendingRoster) { this.reconcile(this.pendingRoster); this.pendingRoster = null; }
    for (const m of this.pendingSignals.splice(0)) this.onSignals(m.from, m.signals);
    this.retryTimer = setInterval(() => this.retryStalled(), RETRY_TICK_MS);
    this.render();
    callButtonsChanged();
  }

  leave(tellWorkspace) {
    if (this.phase === 'left') return;
    const joined = this.callId !== null;
    this.phase = 'left';
    this.broadcast({ t: 'bye' });
    const conns = Array.from(this.conns.values());
    this.conns.clear();
    for (const c of conns) c.peer.destroy();
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.levels.stop();
    for (const s of [this.screenStream, this.localStream]) {
      if (s) for (const t of s.getTracks()) t.stop();
    }
    if (this.placeholderCtx) this.placeholderCtx.close().catch(() => {});
    if (tellWorkspace !== false && joined) this.post('leave', {}).catch(() => {});
    if (this.el) this.el.remove();
    this.el = null;
    document.removeEventListener('keydown', this.keys);
    window.dangoCall.ended(this);
  }

  // A page that is closing cannot wait for a request, so it leaves with a
  // beacon, which the browser sends after the page is gone.
  beaconLeave() {
    if (this.callId === null || !navigator.sendBeacon) return;
    const f = frame();
    const data = new FormData();
    data.append('csrf', f ? f.csrf : '');
    data.append('peer', clientId);
    navigator.sendBeacon(this.room + '/call/leave', data);
  }

  post(path, payload) {
    const f = frame();
    const body = Object.assign({ csrf: f ? f.csrf : '', peer: clientId }, payload);
    return fetch(this.room + '/call/' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then((r) => {
      if (r.status === 204) return {};
      return r.json().catch(() => ({})).then((d) => {
        if (!r.ok) throw new Error(d.error || 'the workspace answered ' + r.status + '.');
        return d;
      });
    });
  }

  // The page's stream reopened: after a drop, or after the workspace
  // restarted and forgot the call. Joining again under the same call id puts
  // the page back in the roster and keeps the call's entry in the timeline;
  // the connections to the others were never the workspace's, and go on.
  streamOpened() {
    if (this.phase !== 'in') return;
    this.post('join', { resume: this.callId }).then((r) => {
      if (this.phase !== 'in') return;
      this.callId = r.call;
      this.setIce(r.ice);
    }, (e) => this.setNotice('The call lost touch with the workspace: ' + e.message));
  }

  setIce(ice) {
    this.ice = ice;
    // The connections already open take the new credentials too, so a relay
    // they use keeps working past the old ones' expiry.
    for (const c of this.conns.values()) {
      try { c.peer.pc.setConfiguration({ iceServers: ice.iceServers }); } catch (e) {}
    }
    if (this.iceTimer) clearTimeout(this.iceTimer);
    const due = ice.expiresAt - Date.now() - ICE_REFRESH_MARGIN_MS;
    this.iceTimer = setTimeout(() => {
      this.iceTimer = null;
      if (this.phase !== 'in') return;
      this.post('ice', {}).then((r) => this.setIce(r.ice), () => this.setIce({ iceServers: this.ice.iceServers, expiresAt: Date.now() + ICE_REFRESH_MARGIN_MS + 60000 }));
    }, Math.max(due, 60000));
  }

  iceServers() {
    return this.ice ? this.ice.iceServers : [];
  }

  // ---- the roster and the mesh ----
  event(msg) {
    if (msg.url !== this.room || this.phase === 'left') return;
    if (msg.type === 'call-roster') {
      if (this.phase === 'joining') this.pendingRoster = msg.peers;
      else this.reconcile(msg.peers);
    } else if (msg.type === 'call-signal' && Array.isArray(msg.signals)) {
      // An offer can overtake the answer to this page's own join.
      if (this.phase === 'joining') this.pendingSignals.push(msg);
      else this.onSignals(msg.from, msg.signals);
    } else if (msg.type === 'call-gone') {
      window.alert(msg.reason);
      this.leave(false);
    }
  }

  reconcile(peers) {
    this.roster = new Map(peers.map((p) => [p.peer, p]));
    for (const p of peers) this.known.set(p.peer, p);
    this.dropAbsent();
    for (const id of this.roster.keys()) if (id !== clientId) this.maybeConnect(id);
    this.render();
  }

  // A page not in the roster is dropped at once if its connection never
  // opened, and after a while if it is connected (see ROSTER_ABSENCE_MS).
  dropAbsent() {
    const now = Date.now();
    for (const [id, conn] of Array.from(this.conns)) {
      if (this.roster.has(id)) { conn.absentSince = 0; continue; }
      if (!conn.absentSince) conn.absentSince = now;
      if (!conn.connected || now - conn.absentSince > ROSTER_ABSENCE_MS) {
        this.conns.delete(id);
        conn.peer.destroy();
        this.levels.unwatch(id);
      }
    }
    if (this.spotlight && this.spotlight !== 'self' && !this.roster.has(this.spotlight) && !this.conns.has(this.spotlight)) this.spotlight = null;
  }

  retryStalled() {
    this.dropAbsent();
    for (const id of this.roster.keys()) if (id !== clientId) this.maybeConnect(id);
    this.render();
  }

  // Only the page that offers retries on a timer. The other keeps its
  // connection waiting: a new offer replaces it (see onSignals), and tearing
  // it down on a clock of its own could land in the middle of a handshake.
  maybeConnect(id) {
    if (this.phase !== 'in' || !this.localStream) return;
    const existing = this.conns.get(id);
    if (existing) {
      if (existing.connected || !existing.peer.initiator || Date.now() - existing.createdAt < CONNECT_RETRY_MS) return;
      this.conns.delete(id);
      existing.peer.destroy();
    }
    // The page with the smaller id makes the offer.
    this.createPeer(id, clientId < id);
  }

  outgoingStream() {
    const s = new MediaStream();
    const audio = this.localStream.getAudioTracks()[0];
    if (audio) s.addTrack(audio);
    const video = (this.screenStream && this.screenStream.getVideoTracks()[0]) || this.localStream.getVideoTracks()[0];
    if (video) s.addTrack(video);
    return s;
  }

  createPeer(id, initiator) {
    const peer = new Peer(initiator, this.outgoingStream(), this.iceServers());
    const conn = {
      peer: peer, createdAt: Date.now(), connected: false, stream: null,
      audioMuted: true, videoMuted: true, screen: false,
      chain: Promise.resolve(), outbox: new Outbox(this, id)
    };
    this.conns.set(id, conn);
    peer.setHandlers({
      signal: (sig) => conn.outbox.push(sig),
      track: (stream) => {
        conn.stream = stream;
        this.levels.watch(id, stream);
        this.render();
      },
      connect: () => {
        conn.connected = true;
        this.sendHello(conn);
        this.applyVideoParamsTo(conn);
        this.render();
      },
      data: (raw) => this.handleControl(id, conn, raw),
      close: () => {
        conn.outbox.close();
        if (this.conns.get(id) === conn) {
          this.conns.delete(id);
          this.levels.unwatch(id);
          this.render();
        }
      }
    });
    return conn;
  }

  onSignals(from, signals) {
    if (this.phase !== 'in' || !this.roster.has(from)) return;
    const offered = signals.some((s) => s && s.type === 'offer');
    let conn = this.conns.get(from);
    // An offer for a connection that already has one is the other page
    // starting over (its attempt stalled first): this side starts over too.
    if (conn && offered && !conn.peer.initiator && conn.peer.hasRemote) {
      this.conns.delete(from);
      conn.peer.destroy();
      conn = null;
    }
    if (!conn) {
      if (!offered || clientId < from) return;
      conn = this.createPeer(from, false);
    }
    for (const s of signals) {
      if (!validSignal(s)) continue;
      conn.chain = conn.chain.then(() => conn.peer.signal(s));
    }
  }

  // ---- the control channel ----
  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const c of this.conns.values()) c.peer.send(payload);
  }

  sendHello(conn) {
    const settings = [];
    for (const key of Object.keys(this.settingsMeta)) {
      settings.push({ key: key, value: this.settings[key], rev: this.settingsMeta[key].rev, by: this.settingsMeta[key].by });
    }
    conn.peer.send(JSON.stringify({ t: 'hello', audioMuted: this.audioMuted, videoMuted: this.effectiveVideoMuted(), screen: !!this.screenStream, settings: settings }));
  }

  handleControl(id, conn, raw) {
    if (this.conns.get(id) !== conn) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      conn.audioMuted = msg.audioMuted !== false;
      conn.videoMuted = msg.videoMuted !== false;
      conn.screen = msg.screen === true;
      if (Array.isArray(msg.settings)) for (const e of msg.settings) this.applyRemoteSetting(e);
      this.render();
    } else if (msg.t === 'set') {
      this.applyRemoteSetting(msg);
    } else if (msg.t === 'mute') {
      if (typeof msg.audio !== 'boolean' || typeof msg.video !== 'boolean') return;
      conn.audioMuted = msg.audio;
      conn.videoMuted = msg.video;
      conn.screen = msg.screen === true;
      this.render();
    } else if (msg.t === 'bye') {
      conn.peer.destroy();
    }
  }

  // ---- the shared quality setting ----
  // One value for the whole call, per-key last-writer-wins as in commonroom:
  // each change bumps a revision and goes to every page, a page arriving late
  // hears the current value in each hello, and a tie at one revision goes to
  // the setter with the smaller id, so every page settles the same way.
  setQuality(q) {
    if (QUALITIES.indexOf(q) < 0 || this.settings.videoQuality === q) return;
    const rev = (this.settingsMeta.videoQuality ? this.settingsMeta.videoQuality.rev : 0) + 1;
    this.settingsMeta.videoQuality = { rev: rev, by: clientId };
    this.settings.videoQuality = q;
    this.broadcast({ t: 'set', key: 'videoQuality', value: q, rev: rev, by: clientId });
    this.applyVideoParamsAll();
    this.render();
  }

  applyRemoteSetting(e) {
    if (!e || e.key !== 'videoQuality' || QUALITIES.indexOf(e.value) < 0) return;
    if (!Number.isInteger(e.rev) || e.rev < 1 || typeof e.by !== 'string' || !/^[0-9a-f]{32}$/.test(e.by)) return;
    const cur = this.settingsMeta.videoQuality;
    const curRev = cur ? cur.rev : 0;
    if (e.rev < curRev) return;
    if (e.rev === curRev && cur && cur.by <= e.by) return;
    this.settingsMeta.videoQuality = { rev: e.rev, by: e.by };
    if (this.settings.videoQuality !== e.value) {
      this.settings.videoQuality = e.value;
      this.applyVideoParamsAll();
    }
    this.render();
  }

  videoParams() {
    const p = QUALITY_PARAMS[this.settings.videoQuality];
    const sharing = this.screenStream !== null;
    // Scaled-down text on a shared screen cannot be read: while sharing, the
    // full resolution goes, and the bitrate and frame rate do the limiting.
    return {
      maxBitrate: p.maxBitrate,
      scaleResolutionDownBy: sharing ? undefined : p.scaleResolutionDownBy,
      maxFramerate: p.maxFramerate,
      degradationPreference: sharing ? 'maintain-resolution' : undefined
    };
  }

  applyVideoParamsAll() {
    for (const c of this.conns.values()) this.applyVideoParamsTo(c);
  }

  applyVideoParamsTo(conn) {
    conn.peer.setVideoParameters(this.videoParams()).then((ok) => {
      // Right at 'connected' the encoding may not be negotiated yet.
      if (!ok) setTimeout(() => conn.peer.setVideoParameters(this.videoParams()), 1500);
    });
  }

  // ---- local media ----
  // Every page carries exactly one audio and one video track, so the offer
  // and answer have the same shape for everyone. A missing or refused device
  // is stood in for by silence or a black frame, and turning it on tries the
  // device again and swaps the real track in on every connection.
  async acquireMedia() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: deviceConstraint('audio'), video: deviceConstraint('video') });
      return { stream: s, mic: true, cam: true, micError: null, camError: null };
    } catch (e) {
      // Asked together, both fail if either does (a camera held by another
      // app, say); asked apart, what works is kept.
    }
    let audio = null, video = null, micError = null, camError = null;
    try { audio = (await navigator.mediaDevices.getUserMedia({ audio: deviceConstraint('audio') })).getAudioTracks()[0] || null; } catch (e) { micError = e; }
    try { video = (await navigator.mediaDevices.getUserMedia({ video: deviceConstraint('video') })).getVideoTracks()[0] || null; } catch (e) { camError = e; }
    const stream = new MediaStream();
    stream.addTrack(audio || this.silentAudioTrack());
    stream.addTrack(video || blackVideoTrack());
    return { stream: stream, mic: audio !== null, cam: video !== null, micError: micError, camError: camError };
  }

  silentAudioTrack() {
    if (!this.placeholderCtx) this.placeholderCtx = new (window.AudioContext || window.webkitAudioContext)();
    return this.placeholderCtx.createMediaStreamDestination().stream.getAudioTracks()[0];
  }

  effectiveVideoMuted() {
    return this.videoMuted && !this.screenStream;
  }

  broadcastMute() {
    this.broadcast({ t: 'mute', audio: this.audioMuted, video: this.effectiveVideoMuted(), screen: !!this.screenStream });
  }

  setAudioMuted(muted) {
    if (!this.localStream || this.audioMuted === muted) return;
    if (!muted && !this.micAvailable) { this.openDevice('audio', '', true); return; }
    this.audioMuted = muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !muted;
    this.broadcastMute();
    this.render();
  }

  setVideoMuted(muted) {
    if (!this.localStream || this.videoMuted === muted) return;
    if (!muted && !this.camAvailable) { this.openDevice('video', '', true); return; }
    this.videoMuted = muted;
    for (const t of this.localStream.getVideoTracks()) t.enabled = !muted;
    this.broadcastMute();
    this.render();
  }

  // Open a device (a chosen one, or the saved or default one) and put its
  // track in place of the one being sent. turnOn is for a button pressed
  // with no device yet, which means the person wants it on.
  async openDevice(kind, deviceId, turnOn) {
    const what = kind === 'audio' ? 'microphone' : 'camera';
    const c = deviceConstraint(kind);
    if (deviceId) c.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: c } : { video: c });
    } catch (e) {
      this.setNotice(mediaErrorMessage(what, e));
      return;
    }
    const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!track || this.phase === 'left' || !this.localStream) { for (const t of stream.getTracks()) t.stop(); return; }
    const old = kind === 'audio' ? this.localStream.getAudioTracks()[0] : this.localStream.getVideoTracks()[0];
    // While sharing a screen, the connections carry the screen; the camera
    // goes to them when the share stops.
    if (kind === 'audio' || !this.screenStream) for (const conn of this.conns.values()) conn.peer.replaceTrack(kind, track);
    if (old) { this.localStream.removeTrack(old); old.stop(); }
    this.localStream.addTrack(track);
    if (kind === 'audio') {
      this.micAvailable = true;
      if (turnOn) this.audioMuted = false;
      track.enabled = !this.audioMuted;
      this.levels.watch('self', this.localStream);
    } else {
      this.camAvailable = true;
      if (turnOn) this.videoMuted = false;
      track.enabled = !this.videoMuted;
    }
    if (this.notice && this.notice.indexOf(what) >= 0) this.notice = '';
    this.broadcastMute();
    this.render(true);
  }

  async useDevice(kind, deviceId) {
    store(DEVICE_KEYS[kind], deviceId);
    if (kind === 'speaker') {
      this.speaker = deviceId;
      this.render(true);
      return;
    }
    await this.openDevice(kind, deviceId, false);
  }

  // ---- screen share ----
  // The screen replaces the camera on every connection, so everyone sees the
  // screen in this page's tile; the browser's own "Stop sharing" ends it too.
  async startScreenShare() {
    if (this.phase !== 'in' || this.screenStream) return;
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch (e) { return; }
    const track = stream.getVideoTracks()[0];
    if (!track || this.phase !== 'in') { for (const t of stream.getTracks()) t.stop(); return; }
    this.screenStream = stream;
    for (const conn of this.conns.values()) conn.peer.replaceTrack('video', track);
    this.applyVideoParamsAll();
    this.broadcastMute();
    track.onended = () => this.stopScreenShare();
    this.render(true);
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    const screen = this.screenStream;
    this.screenStream = null;
    const cam = this.localStream && this.localStream.getVideoTracks()[0];
    if (cam) for (const conn of this.conns.values()) conn.peer.replaceTrack('video', cam);
    for (const t of screen.getTracks()) t.stop();
    if (this.phase === 'in') {
      this.applyVideoParamsAll();
      this.broadcastMute();
      this.render(true);
    }
  }

  setNotice(text) {
    this.notice = text;
    this.render();
  }

  // ---- the dock ----
  buildDock() {
    const el = document.createElement('section');
    el.className = 'call-dock';
    el.setAttribute('aria-label', 'Call in ' + this.title);
    el.innerHTML =
      '<div class="call-bar"><a class="call-where"></a><span class="call-status" role="status"></span>' +
      '<button type="button" class="call-ctl call-size" data-call-act="size"></button></div>' +
      '<div class="call-notice" hidden><span></span><button type="button" class="call-ctl" data-call-act="dismiss" aria-label="Dismiss" title="Dismiss">' + ICONS.x + '</button></div>' +
      '<div class="call-tiles"></div>' +
      '<div class="call-settings" hidden>' +
      '<label>Microphone <select data-call-device="audio"></select></label>' +
      '<label>Camera <select data-call-device="video"></select></label>' +
      (canPickSpeaker ? '<label>Speaker <select data-call-device="speaker"></select></label>' : '') +
      '<label>Video quality <select data-call-quality>' + QUALITIES.map((q) => '<option value="' + q + '">' + QUALITY_LABELS[q] + '</option>').join('') + '</select></label>' +
      '<p class="muted">The quality is the whole call\\'s: changing it changes what everyone sends. Lower suits slower connections, since each person sends their video to each other one.</p>' +
      '</div>' +
      '<div class="call-controls">' +
      controlButton('mic', 'Microphone') + controlButton('cam', 'Camera') +
      (canShareScreen ? controlButton('screen', 'Share your screen') : '') +
      controlButton('settings', 'Devices and quality') +
      '<button type="button" class="call-leave" data-call-act="leave" title="Leave the call">' + ICONS.leave + '<span>Leave</span></button>' +
      '</div>';
    el.querySelector('.call-where').textContent = this.title;
    el.querySelector('.call-where').setAttribute('href', this.room);
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
    el.querySelector('.call-bar').addEventListener('pointerdown', (e) => this.dragStart(e));
    this.el = el;
    this.keys = (e) => {
      if (e.key === 'Escape' && this.full && this.el && !this.el.querySelector('.call-settings:not([hidden])')) this.setFull(false);
    };
    document.addEventListener('keydown', this.keys);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { if (this.settingsOpen()) this.fillDevices(); });
    }
  }

  onClick(e) {
    // The room's link, followed from the full page, shows the room.
    if (closestOf(e.target, '.call-where') && this.full) { this.full = false; this.spotlight = null; }
    const b = closestOf(e.target, '[data-call-act]');
    if (b) {
      const act = b.getAttribute('data-call-act');
      if (act === 'mic') this.setAudioMuted(!this.audioMuted);
      else if (act === 'cam') this.setVideoMuted(!this.videoMuted);
      else if (act === 'screen') { if (this.screenStream) this.stopScreenShare(); else this.startScreenShare(); }
      else if (act === 'settings') this.toggleSettings();
      else if (act === 'size') this.setFull(!this.full);
      else if (act === 'dismiss') this.setNotice('');
      else if (act === 'leave') this.leave();
      return;
    }
    // In full page, a tile pressed fills the page, and pressed again goes back.
    const tile = closestOf(e.target, '.call-tile');
    if (tile && this.full) {
      const id = tile.getAttribute('data-peer');
      this.spotlight = this.spotlight === id ? null : id;
      this.render();
    }
  }

  onChange(e) {
    const t = e.target;
    if (t.matches('[data-call-device]')) this.useDevice(t.getAttribute('data-call-device'), t.value);
    else if (t.matches('[data-call-quality]')) this.setQuality(t.value);
  }

  settingsOpen() {
    return this.el && !this.el.querySelector('.call-settings').hidden;
  }

  toggleSettings() {
    const box = this.el.querySelector('.call-settings');
    box.hidden = !box.hidden;
    if (!box.hidden) this.fillDevices();
    this.render();
  }

  // The devices, by the names the browser gives them once a device has been
  // allowed, with the one in use chosen.
  fillDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then((list) => {
      if (!this.el) return;
      const using = {
        audio: this.trackDevice('audio'),
        video: this.trackDevice('video'),
        speaker: this.speaker
      };
      const kinds = { audio: 'audioinput', video: 'videoinput', speaker: 'audiooutput' };
      for (const kind of Object.keys(kinds)) {
        const sel = this.el.querySelector('[data-call-device="' + kind + '"]');
        if (!sel) continue;
        const devices = list.filter((d) => d.kind === kinds[kind]);
        sel.innerHTML = '';
        devices.forEach((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || (kind === 'audio' ? 'Microphone ' : kind === 'video' ? 'Camera ' : 'Speaker ') + (i + 1);
          if (d.deviceId === using[kind]) o.selected = true;
          sel.appendChild(o);
        });
        sel.disabled = devices.length === 0;
      }
    }, () => {});
  }

  trackDevice(kind) {
    if (!this.localStream) return '';
    const t = kind === 'audio' ? this.localStream.getAudioTracks()[0] : this.localStream.getVideoTracks()[0];
    const available = kind === 'audio' ? this.micAvailable : this.camAvailable;
    return t && available && t.getSettings ? t.getSettings().deviceId || '' : '';
  }

  setFull(on) {
    this.full = on;
    if (!on) this.spotlight = null;
    this.place();
  }

  // Where the dock goes: over everything when full page; under the header
  // of the call's own room when that room is on screen; else floating.
  place() {
    const el = this.el;
    if (!el) return;
    const f = frame();
    const head = f && f.room === this.room ? document.querySelector('.app-main > .room-head') : null;
    let kind;
    if (this.full) {
      kind = 'full';
      if (el.parentNode !== document.body) document.body.appendChild(el);
    } else if (head) {
      kind = 'strip';
      if (head.nextElementSibling !== el) head.after(el);
    } else {
      kind = 'mini';
      if (el.parentNode !== document.body) document.body.appendChild(el);
    }
    el.classList.remove('strip', 'full', 'mini');
    el.classList.add(kind);
    this.kind = kind;
    if (kind === 'mini' && this.miniPos) {
      el.style.left = this.miniPos.x + 'px';
      el.style.top = this.miniPos.y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    } else {
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    }
    this.render();
    // A video moved in the page may have paused on the way; it is started again.
    for (const v of el.querySelectorAll('video')) if (v.srcObject && v.paused) v.play().catch(() => {});
  }

  // Out of the page while the page script swaps in the next one.
  park() {
    if (this.el && this.el.parentNode !== document.body) document.body.appendChild(this.el);
  }

  // The floating dock is moved by its bar.
  dragStart(e) {
    if (this.kind !== 'mini' || e.button !== 0 || closestOf(e.target, 'a, button')) return;
    const el = this.el;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy));
      this.miniPos = { x: x, y: y };
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    e.preventDefault();
  }

  // Who shows in the floating dock, which has room for one: someone sharing
  // a screen, else whoever spoke last, else the first other person.
  featured(ids) {
    const others = ids.filter((id) => id !== 'self');
    for (const id of others) { const c = this.conns.get(id); if (c && c.screen) return id; }
    if (this.lastSpeaker && others.indexOf(this.lastSpeaker) >= 0) return this.lastSpeaker;
    return others[0] || 'self';
  }

  render(restream) {
    const el = this.el;
    if (!el) return;
    const ids = ['self'];
    for (const id of this.roster.keys()) if (id !== clientId) ids.push(id);
    for (const id of this.conns.keys()) if (ids.indexOf(id) < 0) ids.push(id);
    const people = this.phase === 'in' ? Math.max(1, this.roster.size) : 0;
    el.querySelector('.call-status').textContent = this.phase === 'joining' ? 'Joining…' : people + ' in the call';
    const size = el.querySelector('.call-size');
    setHtml(size, this.full ? ICONS.collapse : ICONS.expand);
    size.title = this.full ? 'Back to the room' : 'Full page';
    size.setAttribute('aria-label', size.title);
    const notice = el.querySelector('.call-notice');
    notice.hidden = !this.notice;
    notice.firstChild.textContent = this.notice;
    this.renderControls();
    const spot = this.spotlight && ids.indexOf(this.spotlight) >= 0 ? this.spotlight : null;
    el.classList.toggle('spot', this.full && spot !== null);
    const feature = this.featured(ids);
    const box = el.querySelector('.call-tiles');
    for (const [id, tile] of Array.from(this.tiles)) {
      if (ids.indexOf(id) < 0) { tile.remove(); this.tiles.delete(id); }
    }
    ids.forEach((id, i) => {
      let tile = this.tiles.get(id);
      if (!tile) { tile = this.makeTile(id); this.tiles.set(id, tile); }
      if (box.children[i] !== tile) box.insertBefore(tile, box.children[i] || null);
      this.renderTile(tile, id, restream);
      tile.classList.toggle('featured', id === feature);
      tile.classList.toggle('spotlit', id === spot);
    });
    el.style.setProperty('--call-count', String(ids.length));
  }

  renderControls() {
    const el = this.el;
    const set = (act, icon, label, on) => {
      const b = el.querySelector('[data-call-act="' + act + '"]');
      if (!b) return;
      setHtml(b, icon);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.toggle('off', !on);
      b.disabled = !this.localStream;
    };
    set('mic', this.audioMuted ? ICONS.micOff : ICONS.mic, this.audioMuted ? 'Turn your microphone on' : 'Turn your microphone off', !this.audioMuted);
    set('cam', this.videoMuted ? ICONS.videoOff : ICONS.video, this.videoMuted ? 'Turn your camera on' : 'Turn your camera off', !this.videoMuted);
    const screen = el.querySelector('[data-call-act="screen"]');
    if (screen) {
      setHtml(screen, ICONS.screen);
      screen.title = this.screenStream ? 'Stop sharing your screen' : 'Share your screen';
      screen.setAttribute('aria-label', screen.title);
      screen.classList.toggle('active', !!this.screenStream);
      screen.disabled = this.phase !== 'in';
    }
    const settings = el.querySelector('[data-call-act="settings"]');
    setHtml(settings, ICONS.sliders);
    settings.classList.toggle('active', this.settingsOpen());
    const quality = el.querySelector('[data-call-quality]');
    if (quality.value !== this.settings.videoQuality) quality.value = this.settings.videoQuality;
  }

  makeTile(id) {
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.setAttribute('data-peer', id);
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    if (id === 'self') v.muted = true;
    tile.appendChild(v);
    const face = document.createElement('div');
    face.className = 'call-face';
    tile.appendChild(face);
    const label = document.createElement('div');
    label.className = 'call-label';
    tile.appendChild(label);
    const wait = document.createElement('span');
    wait.className = 'call-wait';
    wait.textContent = 'Connecting…';
    tile.appendChild(wait);
    return tile;
  }

  renderTile(tile, id, restream) {
    const me = frame() ? frame().viewer : '';
    let stream, name, audioMuted, videoOff, connecting, mirror, screen;
    if (id === 'self') {
      const r = this.roster.get(clientId);
      stream = this.screenStream || this.localStream;
      name = 'You';
      audioMuted = this.audioMuted;
      screen = !!this.screenStream;
      videoOff = !screen && (this.videoMuted || !this.camAvailable);
      connecting = false;
      mirror = !screen;
      tile.dataset.user = r ? r.user : me;
      if (r && !tile.dataset.face) { tile.querySelector('.call-face').innerHTML = r.face; tile.dataset.face = '1'; }
    } else {
      const r = this.known.get(id);
      const c = this.conns.get(id);
      stream = c ? c.stream : null;
      name = r ? r.user : '';
      audioMuted = c ? c.audioMuted : true;
      screen = c ? c.screen : false;
      videoOff = !c || (c.videoMuted && !c.screen);
      connecting = !c || !c.connected;
      mirror = false;
      if (r && !tile.dataset.face) { tile.querySelector('.call-face').innerHTML = r.face; tile.dataset.face = '1'; }
    }
    const v = tile.querySelector('video');
    if (v.srcObject !== stream || restream) {
      v.srcObject = stream || null;
      if (stream) v.play().catch(() => {});
    }
    if (id !== 'self' && canPickSpeaker && this.speaker && v.sinkId !== this.speaker) v.setSinkId(this.speaker).catch(() => {});
    tile.classList.toggle('video-off', videoOff || connecting);
    tile.classList.toggle('connecting', connecting);
    tile.classList.toggle('mirror', mirror);
    tile.classList.toggle('screen', screen);
    tile.classList.toggle('speaking', this.speaking.has(id) && !audioMuted);
    const label = tile.querySelector('.call-label');
    const text = escapeHtml(name) + (audioMuted ? ' <span class="call-muted" title="Microphone off">' + ICONS.micOff + '</span>' : '');
    setHtml(label, text);
    tile.title = id === 'self' ? 'You' : name;
  }
}

// ---- the page's handle on it ----
let current = null;
window.dangoCall = {
  join: function (url, title) {
    if (current && current.room === url) { current.setFull(true); return; }
    if (current) {
      if (!window.confirm('Leave the call in ' + current.title + ' and join the one in ' + title + '?')) return;
      current.leave();
    }
    current = new Call(url, title);
    current.start();
    callButtonsChanged();
  },
  ended: function (call) {
    if (current === call) current = null;
    callButtonsChanged();
  },
  event: function (msg) { if (current) current.event(msg); },
  streamOpened: function () { if (current) current.streamOpened(); },
  park: function () { if (current) current.park(); },
  place: function () { if (current) current.place(); },
  active: function () { return current !== null; },
  room: function () { return current ? current.room : ''; }
};
// Closing the page, or leaving it for another site, is leaving the call.
window.addEventListener('pagehide', function () {
  if (!current) return;
  current.beaconLeave();
  current.leave(false);
});
})();
`;

let made: { body: string; tag: string } | null = null;

export function callScript(): { body: string; tag: string } {
  if (!made) {
    made = { body: CALL_JS, tag: createHash('sha256').update(CALL_JS).digest('hex').slice(0, 12) };
  }
  return made;
}
