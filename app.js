// Видеозвонок 1 на 1 без своего сервера.
// Браузеры находят друг друга через публичный сервер PeerJS (он пересылает только
// служебные сообщения), дальше видео и звук идут напрямую между браузерами.
//
// Комната = адрес вида ?room=abc. Кто зашёл первым, занимает имя комнаты и ждёт,
// второй звонит ему. Если первый ушёл, оставшийся сам занимает комнату.

const $ = id => document.getElementById(id);
const CFG = window.CALL_CONFIG || {};
const PREFIX = 'p2pcall-v1-';
const roomId = new URLSearchParams(location.search).get('room');

const state = {
  peer: null,
  call: null,
  isHost: false,
  gotStream: false,
  failed: false,
  leaving: false,
  localStream: null, // то, что реально дала камера/микрофон
  camTrack: null,
  micTrack: null,
  blankVideo: null,  // заглушки, если устройства нет: канал создаётся всегда,
  silentAudio: null, // чтобы потом можно было включить демонстрацию экрана
  screenTrack: null,
  disconnectTimer: null,
};

// ---------- Экран входа ----------

if (!window.isSecureContext) $('secureWarn').hidden = false;

if (roomId) {
  $('createBtn').hidden = true;
  $('joinBtn').hidden = false;
  $('newRoomLink').hidden = false;
  $('lobbyText').textContent = `Комната ${roomId}. Камера и микрофон включатся после входа.`;
}

$('createBtn').onclick = () => {
  location.search = '?room=' + randomId();
};
$('joinBtn').onclick = enterRoom;
$('rejoinBtn').onclick = () => location.reload();

function randomId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function enterRoom() {
  if (typeof Peer === 'undefined') {
    toast('Не загрузился файл peerjs.min.js — проверьте, что он лежит рядом с index.html');
    return;
  }
  $('joinBtn').disabled = true;

  state.localStream = await getLocalMedia();
  state.camTrack = state.localStream.getVideoTracks()[0] || null;
  state.micTrack = state.localStream.getAudioTracks()[0] || null;
  if (!state.camTrack) state.blankVideo = makeBlankVideo();
  if (!state.micTrack) state.silentAudio = makeSilentAudio();

  showLocal(state.localStream, true);
  updateButtons();
  $('lobby').hidden = true;
  $('call').hidden = false;
  $('shareInput').value = location.href;

  joinRoom();
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

function makeBlankVideo() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c.captureStream(1).getVideoTracks()[0];
}

function makeSilentAudio() {
  try {
    const ac = new AudioContext();
    return ac.createMediaStreamDestination().stream.getAudioTracks()[0];
  } catch { return null; }
}

function outgoingStream() {
  const tracks = [state.micTrack || state.silentAudio, currentVideoTrack()].filter(Boolean);
  return new MediaStream(tracks);
}

function currentVideoTrack() {
  return state.screenTrack || state.camTrack || state.blankVideo;
}

// ---------- Подключение ----------

function peerOptions() {
  const opts = { ...(CFG.peerServer || {}) };
  if (CFG.iceServers) opts.config = { iceServers: CFG.iceServers };
  return opts;
}

// Пытаемся занять имя комнаты. Если занято — значит, там уже ждут, звоним им.
function joinRoom() {
  if (state.leaving) return;
  setStatus('Подключаемся…');
  const peer = new Peer(PREFIX + roomId, peerOptions());
  state.peer = peer;

  peer.on('open', () => {
    state.isHost = true;
    if (!state.call) setStatus('Ждём собеседника. Отправьте ему ссылку:', true);
  });

  peer.on('call', incoming => {
    if (state.call) { rejectBusy(incoming); return; } // уже идёт звонок — третьего не пускаем
    attachCall(incoming);
    incoming.answer(outgoingStream());
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      callHost();
    } else {
      handlePeerError(err);
    }
  });

  peer.on('disconnected', () => {
    if (!state.leaving && !peer.destroyed) peer.reconnect();
  });
}

function callHost() {
  if (state.leaving) return;
  const peer = new Peer(peerOptions());
  state.peer = peer;
  state.isHost = false;

  peer.on('open', () => {
    const call = peer.call(PREFIX + roomId, outgoingStream());
    attachCall(call);
    // Если за 25 секунд так и не соединились — сообщаем, а не висим молча.
    setTimeout(() => {
      if (state.call === call && !state.gotStream) {
        state.failed = true;
        call.close();
        onCallEnded(call);
      }
    }, 25000);
  });

  // Хозяин комнаты может ответить «занято».
  peer.on('connection', conn => {
    conn.on('data', msg => {
      if (msg?.type === 'busy') showBusy();
      conn.close();
    });
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      // Тот, кто ждал, уже ушёл — пробуем занять комнату сами.
      state.call = null;
      peer.destroy();
      setTimeout(joinRoom, 1000);
    } else {
      handlePeerError(err);
    }
  });
}

function rejectBusy(incoming) {
  const conn = state.peer.connect(incoming.peer);
  conn.on('open', () => {
    conn.send({ type: 'busy' });
    setTimeout(() => conn.close(), 1000);
  });
  setTimeout(() => incoming.close(), 1500);
}

function showBusy() {
  const call = state.call;
  state.call = null;
  state.leaving = true; // дальше не переподключаемся
  call?.close();
  state.peer?.destroy();
  $('remoteVideo').srcObject = null;
  setStatus('В этой комнате уже идёт звонок. Создайте новую комнату.');
}

function handlePeerError(err) {
  console.warn('PeerJS:', err.type, err);
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
    setStatus('Нет связи с сервером соединений. Проверьте интернет и обновите страницу.');
  } else if (err.type === 'browser-incompatible') {
    setStatus('Этот браузер не поддерживает видеозвонки. Попробуйте Chrome, Edge, Firefox или Safari.');
  }
}

function attachCall(call) {
  state.call = call;
  state.gotStream = false;
  state.failed = false;

  call.on('stream', stream => {
    state.gotStream = true;
    $('remoteVideo').srcObject = stream;
    hideStatus();
  });
  call.on('close', () => onCallEnded(call));
  call.on('error', () => onCallEnded(call));

  const pc = call.peerConnection;
  pc?.addEventListener('connectionstatechange', () => {
    if (call !== state.call) return;
    clearTimeout(state.disconnectTimer);
    switch (pc.connectionState) {
      case 'connected':
        if (state.gotStream) hideStatus();
        break;
      case 'disconnected':
        setStatus('Связь прервалась, пробуем восстановить…');
        // Если собеседник закрыл вкладку, связь сама не вернётся.
        state.disconnectTimer = setTimeout(() => call.close(), 8000);
        break;
      case 'failed':
        state.failed = true;
        call.close();
        break;
    }
  });
}

function onCallEnded(call) {
  if (call !== state.call) return;
  clearTimeout(state.disconnectTimer);
  state.call = null;
  $('remoteVideo').srcObject = null;
  if (state.leaving) return;

  if (state.failed) {
    setStatus('Не удалось соединиться напрямую: сеть блокирует звонок. Попробуйте другую сеть или свой TURN-сервер (см. README).');
    return;
  }
  setStatus('Собеседник вышел. Ждём, пока он вернётся:', true);
  if (!state.isHost) {
    // Ушёл тот, кто занимал комнату, — занимаем её сами и ждём.
    state.peer?.destroy();
    setTimeout(joinRoom, 1000);
  }
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

function videoSender() {
  return state.call?.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
}

$('screenBtn').onclick = async () => {
  if (state.screenTrack) return stopScreenShare();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return toast('Демонстрация экрана не поддерживается в этом браузере');
  }

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

  await videoSender()?.replaceTrack(track);
  showLocal(new MediaStream([track]), false);
  updateButtons();
};

async function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.onended = null;
  state.screenTrack.stop();
  state.screenTrack = null;
  await videoSender()?.replaceTrack(currentVideoTrack());
  showLocal(state.localStream, true);
  updateButtons();
}

$('hangupBtn').onclick = () => {
  state.leaving = true;
  clearTimeout(state.disconnectTimer);
  state.call?.close();
  state.peer?.destroy();
  state.screenTrack?.stop();
  state.localStream?.getTracks().forEach(t => t.stop());
  $('remoteVideo').srcObject = null;
  $('call').hidden = true;
  $('ended').hidden = false;
};

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    $('shareInput').select();
    document.execCommand('copy');
  }
  toast('Ссылка скопирована');
};

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

function setStatus(text, withShare = false) {
  $('overlay').hidden = false;
  $('status').textContent = text;
  $('shareBox').hidden = !withShare;
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
