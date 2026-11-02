// Настройки сервиса. Обычно здесь ничего менять не нужно.
window.CALL_CONFIG = {
  // Сервер-«справочная», через которую браузеры находят друг друга.
  // null — бесплатный публичный сервер PeerJS (0.peerjs.com).
  // Свой сервер, например: { host: 'peer.example.com', port: 443, path: '/', secure: true }
  peerServer: null,

  // STUN/TURN-серверы. null — встроенные в PeerJS (STUN от Google + бесплатный TURN от PeerJS).
  // Свои, например:
  // [{ urls: 'stun:stun.l.google.com:19302' },
  //  { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
  iceServers: null,
};
