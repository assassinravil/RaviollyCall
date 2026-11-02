// Видеозвонок 1 на 1 без своего сервера.
//
// Как браузеры находят друг друга: через несколько бесплатных публичных MQTT-серверов
// сразу (если один недоступен, работают остальные). Через них идут только короткие
// служебные сообщения, зашифрованные ключом из ссылки на комнату. Серверы видят
// лишь непонятный шифр. Видео и звук идут напрямую между браузерами.
//
// Комната нигде не хранится: это просто общий «канал» по имени из ссылки.
// Пока в нём кто-то есть, комната существует; все вышли — от неё ничего не осталось.

const $ = id => document.getElementById(id);
const CFG = window.CALL_CONFIG || {};

const BROKERS = CFG.brokers || [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
];

const ICE_SERVERS = CFG.iceServers || [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  // Бесплатный ретранслятор (TURN) от проекта PeerJS — для сетей, где напрямую не соединиться.
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

const roomId = new URLSearchParams(location.search).get('room');
const myId = randomId(12);

const state = {
  clients: [],          // подключения к MQTT-серверам
  connectedCount: 0,
  topic: null,
  key: null,
  seen: new Set(),      // одно сообщение приходит через несколько серверов — отбрасываем повторы
  queue: Promise.resolve(),
  helloTimer: null,

  peerId: null,
  pc: null,
  pendingCandidates: [],
  diag: { local: {}, remote: {} },
  senders: {},
  connectTimer: null,
  disconnectTimer: null,
  stopped: false,       // вышли из звонка или комната занята

  localStream: null,
  camTrack: null,
  micTrack: null,
  screenTrack: null,
};

// ---------- Экран входа ----------

if (!window.isSecureContext) $('secureWarn').hidden = false;

if (roomId) {
  $('createBtn').hidden = true;
  $('joinBtn').hidden = false;
  $('newRoomLink').hidden = false;
  $('lobbyText').textContent = 'Вас пригласили в звонок. Камера и микрофон включатся после входа.';
}

$('createBtn').onclick = () => { location.search = '?room=' + randomId(10); };
$('joinBtn').onclick = enterRoom;
$('rejoinBtn').onclick = () => location.reload();
$('newCallBtn').onclick = () => { location.href = location.pathname + '?room=' + randomId(10); };

function randomId(len) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function enterRoom() {
  if (typeof mqtt === 'undefined') {
    return toast('Не загрузился файл mqtt.min.js — проверьте, что он лежит рядом с index.html');
  }
  if (!crypto.subtle) {
    return toast('Нужен HTTPS: откройте сервис по адресу https://…');
  }
  $('joinBtn').disabled = true;

  state.localStream = await getLocalMedia();
  state.camTrack = state.localStream.getVideoTracks()[0] || null;
  state.micTrack = state.localStream.getAudioTracks()[0] || null;

  showLocal(state.localStream, true);
  updateButtons();
  $('lobby').hidden = true;
  $('call').hidden = false;
  $('shareInput').value = location.href;

  await initCrypto();
  connectBrokers();
}

async function getLocalMedia() {
  const attempts = [
    { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } },
    { audio: true },
    { video: true },
  ];
  if (navigator.mediaDevices?.getUserMedia) {
    for (const c of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch { /* пробуем следующее */ }
    }
  }
  toast('Нет доступа к камере и микрофону — вы сможете только смотреть и слушать.');
  return new MediaStream();
}

// ---------- Шифрование служебных сообщений ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function initCrypto() {
  const h = await sha256('p2pcall-topic:' + roomId);
  state.topic = 'p2pcall/v2/' + Array.from(h.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  state.key = await crypto.subtle.importKey('raw', await sha256('p2pcall-key:' + roomId), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + data.length);
  out.set(iv);
  out.set(data, 12);
  return out;
}

async function decrypt(bytes) {
  const u = new Uint8Array(bytes);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, state.key, u.slice(12));
  return JSON.parse(dec.decode(plain));
}

// ---------- Серверы связи (MQTT) ----------

function connectBrokers() {
  setStatus('Подключаемся…');
  BROKERS.forEach((url, i) => {
    let client;
    try {
      client = mqtt.connect(url, {
        clientId: `pc_${myId}_${i}`,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 4000,
        connectTimeout: 8000,
        protocolVersion: 4,
      });
    } catch { return; }

    client.isUp = false;
    client.on('connect', () => {
      client.subscribe(state.topic, { qos: 0 }, err => {
        if (err) return;
        client.isUp = true;
        updateNetInfo();
        sendHello(); // сразу заявляем о себе
      });
    });
    const down = () => { if (client.isUp) { client.isUp = false; updateNetInfo(); } };
    client.on('close', down);
    client.on('offline', down);
    client.on('error', () => {});
    client.on('message', (topic, payload) => onRawMessage(payload));
    state.clients.push(client);
  });

  // Раз в 4 секунды напоминаем о себе, пока ждём собеседника.
  state.helloTimer = setInterval(() => { if (!state.peerId) sendHello(); }, 4000);

  setTimeout(() => {
    if (!state.connectedCount && !state.stopped) {
      setStatus('Не удаётся подключиться ни к одному серверу связи. Проверьте интернет или попробуйте другую сеть (Wi-Fi / мобильный).');
    }
  }, 12000);
}

function updateNetInfo() {
  state.connectedCount = state.clients.filter(c => c.isUp).length;
  $('netInfo').textContent = `Серверы связи: ${state.connectedCount} из ${BROKERS.length}`;
  if (state.connectedCount && !state.peerId && !state.stopped) showWaiting();
}

// Отправляем строго по очереди: шифрование асинхронное, и без очереди короткое
// сообщение могло бы обогнать длинное (например, ICE-кандидат — offer).
let sendQueue = Promise.resolve();
function publish(msg) {
  sendQueue = sendQueue.then(async () => {
    if (!state.key) return;
    const payload = await encrypt({ ...msg, from: myId, mid: randomId(10) });
    for (const c of state.clients) if (c.isUp) c.publish(state.topic, payload, { qos: 0 });
  }).catch(() => {});
  return sendQueue;
}

function onRawMessage(payload) {
  state.queue = state.queue.then(async () => {
    let msg;
    try { msg = await decrypt(payload); } catch { return; }
    if (!msg || msg.from === myId || state.seen.has(msg.mid)) return;
    state.seen.add(msg.mid);
    if (msg.to && msg.to !== myId) return;
    await handleMessage(msg);
  }).catch(err => console.error(err));
}

function sendHello() {
  if (!state.stopped) publish({ type: 'hello' });
}

// ---------- Логика комнаты ----------

async function handleMessage(msg) {
  if (state.stopped) return;

  switch (msg.type) {
    case 'hello':
      if (msg.from === state.peerId) return;
      if (state.peerId) {
        // Уже разговариваем с другим — третьему отвечаем «занято».
        publish({ type: 'busy', to: msg.from });
        return;
      }
      adoptPeer(msg.from);
      // Чтобы не было «столкновения», звонит тот, у кого id меньше.
      if (myId < msg.from) await startOffer();
      else sendHello();
      return;

    case 'signal':
      if (!state.peerId) adoptPeer(msg.from);
      if (msg.from !== state.peerId) return;
      await handleSignal(msg.data);
      return;

    case 'busy':
      if (!state.pc || state.pc.connectionState !== 'connected') showBusy();
      return;

    case 'bye':
      if (msg.from === state.peerId) peerLeft();
      return;
  }
}

function adoptPeer(id) {
  state.peerId = id;
  setStatus('Собеседник подключается…');
  clearTimeout(state.connectTimer);
  state.connectTimer = setTimeout(() => {
    if (state.pc?.connectionState !== 'connected') connectFailed();
  }, 30000);
}

function peerLeft() {
  clearTimeout(state.connectTimer);
  closePeer();
  state.peerId = null;
  state.pendingCandidates = [];
  state.diag = { local: {}, remote: {} };
  showWaiting('Собеседник вышел. Он может вернуться по той же ссылке:');
  sendHello();
}

function connectFailed() {
  const report = diagReport();
  closePeer();
  state.peerId = null;
  state.stopped = true;
  setStatus('Собеседник найден, но соединиться не удалось — сеть мешает прямому соединению.');
  $('diag').textContent = report;
  $('diag').hidden = false;
}

// ---------- Диагностика соединения ----------
// host — адрес в локальной сети, srflx — внешний адрес (через STUN), relay — через ретранслятор (TURN).

function countCandidate(bucket, line) {
  const type = /typ (\w+)/.exec(line || '')?.[1];
  if (type) bucket[type] = (bucket[type] || 0) + 1;
}

function diagReport() {
  const fmt = d => `локальная сеть ${d.host ? '✓' : '✗'}, интернет ${d.srflx || d.prflx ? '✓' : '✗'}, ретранслятор ${d.relay ? '✓' : '✗'}`;
  const lines = [`У вас: ${fmt(state.diag.local)}`, `У собеседника: ${fmt(state.diag.remote)}`];
  const none = d => !d.host && !d.srflx && !d.prflx && !d.relay;
  if (none(state.diag.remote)) {
    lines.push('От собеседника не пришло ни одного адреса — попробуйте обновить страницу у обоих.');
  } else if (!state.diag.local.relay || !state.diag.remote.relay) {
    lines.push('Бесплатный ретранслятор недоступен в сети. Помогут: одна Wi-Fi-сеть у обоих, другая сеть или свой TURN-сервер (см. README).');
  } else {
    lines.push('Попробуйте другую сеть или свой TURN-сервер (см. README).');
  }
  lines.push('Обновите страницу, чтобы попробовать ещё раз.');
  return lines.join('\n');
}

function showBusy() {
  clearTimeout(state.connectTimer);
  closePeer();
  state.peerId = null;
  state.stopped = true;
  disconnectBrokers();
  setStatus('В этой комнате уже идёт звонок. Создайте новую комнату.');
}

function sendSignal(data) {
  if (state.peerId) publish({ type: 'signal', to: state.peerId, data });
}

// ---------- WebRTC ----------

function createPeer() {
  // Кандидаты, пришедшие раньше offer (через другой сервер связи), не выбрасываем.
  const pending = state.pendingCandidates;
  const remoteTypes = state.diag.remote;
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  state.pendingCandidates = pending;
  state.diag = { local: {}, remote: remoteTypes };
  state.senders = {};

  const remote = new MediaStream();
  pc.ontrack = e => {
    remote.addTrack(e.track);
    $('remoteVideo').srcObject = remote;
  };
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    countCandidate(state.diag.local, e.candidate.candidate);
    sendSignal({ candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc !== state.pc) return;
    clearTimeout(state.disconnectTimer);
    switch (pc.connectionState) {
      case 'connected':
        clearTimeout(state.connectTimer);
        hideStatus();
        break;
      case 'disconnected':
        setStatus('Связь прервалась, пробуем восстановить…');
        state.disconnectTimer = setTimeout(peerLeft, 8000); // собеседник, скорее всего, закрыл вкладку
        break;
      case 'failed':
        connectFailed();
        break;
    }
  };
  return pc;
}

function currentVideoTrack() {
  return state.screenTrack || state.camTrack;
}

async function startOffer() {
  const pc = createPeer();
  const audio = state.micTrack;
  const video = currentVideoTrack();
  // Каналы создаём даже без устройств — чтобы потом можно было включить экран.
  state.senders.audio = pc.addTransceiver(audio || 'audio', { direction: 'sendrecv', streams: [state.localStream] }).sender;
  state.senders.video = pc.addTransceiver(video || 'video', { direction: 'sendrecv', streams: [state.localStream] }).sender;
  await pc.setLocalDescription(await pc.createOffer());
  sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
}

async function handleSignal(data) {
  if (data.description) {
    const desc = data.description;
    if (desc.type === 'offer') {
      const pc = createPeer();
      await pc.setRemoteDescription(desc);
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        const track = kind === 'audio' ? state.micTrack : currentVideoTrack();
        t.direction = 'sendrecv';
        if (track) await t.sender.replaceTrack(track);
        if (t.sender.setStreams) t.sender.setStreams(state.localStream);
        state.senders[kind] = t.sender;
      }
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } else if (desc.type === 'answer' && state.pc && state.pc.signalingState === 'have-local-offer') {
      await state.pc.setRemoteDescription(desc);
    }
    for (const c of state.pendingCandidates) await state.pc?.addIceCandidate(c).catch(() => {});
    state.pendingCandidates = [];
    return;
  }

  if (data.candidate) {
    countCandidate(state.diag.remote, data.candidate.candidate);
    if (state.pc?.remoteDescription) await state.pc.addIceCandidate(data.candidate).catch(() => {});
    else state.pendingCandidates.push(data.candidate);
  }
}

function closePeer() {
  clearTimeout(state.disconnectTimer);
  if (state.pc) {
    state.pc.ontrack = state.pc.onicecandidate = state.pc.onconnectionstatechange = null;
    state.pc.close();
  }
  state.pc = null;
  $('remoteVideo').srcObject = null;
}

function disconnectBrokers() {
  clearInterval(state.helloTimer);
  for (const c of state.clients) { try { c.end(true); } catch { /* ignore */ } }
  state.clients = [];
}

// ---------- Кнопки ----------

$('micBtn').onclick = () => {
  if (!state.micTrack) return toast('Микрофон недоступен');
  state.micTrack.enabled = !state.micTrack.enabled;
  updateButtons();
};

$('camBtn').onclick = () => {
  if (!state.camTrack) return toast('Камера недоступна');
  state.camTrack.enabled = !state.camTrack.enabled;
  updateButtons();
};

$('screenBtn').onclick = async () => {
  if (state.screenTrack) return stopScreenShare();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
  } catch {
    return; // пользователь отменил выбор
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail';
  track.onended = stopScreenShare; // нажали «Остановить» в панели браузера
  state.screenTrack = track;
  await state.senders.video?.replaceTrack(track);
  showLocal(new MediaStream([track]), false);
  updateButtons();
};

async function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.onended = null;
  state.screenTrack.stop();
  state.screenTrack = null;
  await state.senders.video?.replaceTrack(state.camTrack);
  showLocal(state.localStream, true);
  updateButtons();
}

async function leave() {
  if (state.stopped && !state.clients.length) return;
  const wasConnected = !!state.peerId;
  if (wasConnected) await publish({ type: 'bye' }).catch(() => {});
  state.stopped = true;
  clearTimeout(state.connectTimer);
  closePeer();
  state.peerId = null;
  setTimeout(disconnectBrokers, 300); // даём «bye» уйти
  state.screenTrack?.stop();
  state.localStream?.getTracks().forEach(t => t.stop());
}

$('hangupBtn').onclick = async () => {
  await leave();
  $('call').hidden = true;
  $('ended').hidden = false;
};

// Закрыли вкладку — пробуем предупредить собеседника (если не успеем, он поймёт сам через ~10 секунд).
window.addEventListener('pagehide', () => { if (state.peerId) leave(); });

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    $('shareInput').select();
    document.execCommand('copy');
  }
  toast('Ссылка скопирована');
};

if (navigator.share) {
  $('shareBtn').hidden = false;
  $('shareBtn').onclick = () => navigator.share({ title: 'Видеозвонок', url: location.href }).catch(() => {});
}

function updateButtons() {
  $('micBtn').classList.toggle('is-off', !state.micTrack || !state.micTrack.enabled);
  $('camBtn').classList.toggle('is-off', !state.camTrack || !state.camTrack.enabled);
  $('screenBtn').classList.toggle('is-active', !!state.screenTrack);
  $('screenBtn').hidden = !navigator.mediaDevices?.getDisplayMedia;
}

// ---------- Интерфейс ----------

function showLocal(stream, isCamera) {
  const v = $('localVideo');
  v.srcObject = stream;
  v.classList.toggle('mirror', isCamera);
  v.classList.toggle('screen', !isCamera);
}

function showWaiting(text = 'Вы в комнате одни. Отправьте ссылку собеседнику:') {
  setStatus(text, true);
}

function setStatus(text, withShare = false) {
  $('overlay').hidden = false;
  $('status').textContent = text;
  $('shareBox').hidden = !withShare;
  $('roomHint').hidden = !withShare;
}

function hideStatus() {
  $('overlay').hidden = true;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}
