// Настройки сервиса. Обычно здесь ничего менять не нужно.
window.CALL_CONFIG = {
  // Серверы, через которые браузеры находят друг друга (MQTT через WebSocket).
  // Используются все сразу: хватит, чтобы работал хотя бы один.
  // null — встроенный список бесплатных публичных серверов.
  // Пример своего списка: ['wss://broker.emqx.io:8084/mqtt', 'wss://my-broker.example.com/mqtt']
  brokers: null,

  // STUN/TURN-серверы. null — STUN от Google + бесплатный TURN от PeerJS.
  // Пример своих:
  // [{ urls: 'stun:stun.l.google.com:19302' },
  //  { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
  iceServers: null,
};
