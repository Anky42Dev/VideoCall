const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/';
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const elements = {
  localVideo: document.querySelector('#localVideo'),
  remoteVideo: document.querySelector('#remoteVideo'),
  waitingPanel: document.querySelector('#waitingPanel'),
  waitingTitle: document.querySelector('#waitingTitle'),
  waitingText: document.querySelector('#waitingText'),
  remoteLabel: document.querySelector('#remoteLabel'),
  cameraOff: document.querySelector('#cameraOff'),
  connectionStatus: document.querySelector('#connectionStatus'),
  statusDot: document.querySelector('#statusDot'),
  micButton: document.querySelector('#micButton'),
  cameraButton: document.querySelector('#cameraButton'),
  hangupButton: document.querySelector('#hangupButton'),
  copyLinkButton: document.querySelector('#copyLinkButton'),
  toast: document.querySelector('#toast'),
};

let socket;
let peerConnection;
let localStream;
let remoteStream;
let remoteId = null;
let pendingCandidates = [];
let reconnectTimer;
let toastTimer;
let intentionallyClosed = false;
const clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function setStatus(text, state = 'loading') {
  elements.connectionStatus.textContent = text;
  elements.statusDot.className = `status-dot ${state === 'online' ? 'online' : state === 'error' ? 'error' : ''}`;
}

function setWaiting(title, text) {
  elements.waitingTitle.textContent = title;
  elements.waitingText.textContent = text;
  elements.waitingPanel.classList.remove('hidden');
  elements.remoteVideo.classList.remove('visible');
  elements.remoteLabel.hidden = true;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

async function startMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    elements.localVideo.srcObject = localStream;
    elements.micButton.disabled = false;
    elements.cameraButton.disabled = false;
    elements.hangupButton.disabled = false;
    return true;
  } catch (error) {
    console.error('Не удалось получить доступ к камере и микрофону:', error);
    setStatus('Нет доступа к устройствам', 'error');
    setWaiting('Нужен доступ к камере', 'Разрешите браузеру использовать камеру и микрофон, затем обновите страницу.');
    elements.micButton.disabled = true;
    elements.cameraButton.disabled = true;
    elements.hangupButton.disabled = true;
    return false;
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function createPeerConnection() {
  if (peerConnection) return peerConnection;

  pendingCandidates = [];
  remoteStream = new MediaStream();
  elements.remoteVideo.srcObject = remoteStream;
  peerConnection = new RTCPeerConnection(RTC_CONFIG);

  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'ice-candidate', candidate });
  };

  peerConnection.ontrack = ({ streams, track }) => {
    const incomingStream = streams[0];
    if (incomingStream) {
      elements.remoteVideo.srcObject = incomingStream;
    } else if (!remoteStream.getTracks().includes(track)) {
      remoteStream.addTrack(track);
    }
    elements.waitingPanel.classList.add('hidden');
    elements.remoteVideo.classList.add('visible');
    elements.remoteLabel.hidden = false;
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    const state = peerConnection.connectionState;
    if (state === 'connected') setStatus('Вы на связи', 'online');
    if (state === 'failed') {
      setStatus('Связь потеряна', 'error');
      setWaiting('Не удалось соединиться', 'Попробуйте обновить страницу в обоих окнах.');
    }
  };

  return peerConnection;
}

async function makeOffer() {
  const pc = createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: pc.localDescription });
}

async function addPendingCandidates() {
  const candidates = pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(candidate);
  }
}

async function handleSignal(message) {
  switch (message.type) {
    case 'hello': {
      if (!message.id || message.id === clientId) return;
      const isNewPeer = remoteId !== message.id;
      remoteId = message.id;
      if (message.replyRequested) send({ type: 'hello', id: clientId, replyRequested: false });
      if (isNewPeer) {
        setStatus('Соединяем…');
        if (clientId.localeCompare(remoteId) < 0) await makeOffer();
      }
      break;
    }
    case 'offer': {
      const pc = createPeerConnection();
      await pc.setRemoteDescription(message.sdp);
      await addPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: pc.localDescription });
      break;
    }
    case 'answer':
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(message.sdp);
      await addPendingCandidates();
      break;
    case 'ice-candidate':
      if (!message.candidate) return;
      if (peerConnection?.remoteDescription) {
        await peerConnection.addIceCandidate(message.candidate);
      } else {
        pendingCandidates.push(message.candidate);
      }
      break;
    case 'peer-left':
      resetPeer();
      setStatus('Ждём собеседника', 'online');
      setWaiting('Собеседник вышел', 'Оставьте страницу открытой — новый участник подключится автоматически.');
      send({ type: 'hello', id: clientId, replyRequested: true });
      break;
  }
}

function connectSignaling() {
  clearTimeout(reconnectTimer);
  setStatus('Подключаемся…');
  socket = new WebSocket(SIGNALING_URL);

  socket.addEventListener('open', () => {
    setStatus('Ждём собеседника', 'online');
    send({ type: 'hello', id: clientId, replyRequested: true });
  });

  socket.addEventListener('message', async (event) => {
    try {
      const message = JSON.parse(event.data);
      await handleSignal(message);
    } catch (error) {
      console.error('Ошибка обработки signaling-сообщения:', error);
    }
  });

  socket.addEventListener('close', () => {
    if (intentionallyClosed) return;
    setStatus('Переподключаемся…', 'error');
    reconnectTimer = setTimeout(connectSignaling, 2000);
  });

  socket.addEventListener('error', () => setStatus('Ошибка сервера', 'error'));
}

function resetPeer() {
  peerConnection?.close();
  peerConnection = null;
  remoteId = null;
  pendingCandidates = [];
  elements.remoteVideo.srcObject = null;
}

function toggleTrack(kind, button) {
  const track = localStream?.getTracks().find((item) => item.kind === kind);
  if (!track) return;
  track.enabled = !track.enabled;
  const isOff = !track.enabled;
  button.setAttribute('aria-pressed', String(isOff));
  button.setAttribute('aria-label', `${isOff ? 'Включить' : 'Выключить'} ${kind === 'audio' ? 'микрофон' : 'камеру'}`);
  if (kind === 'video') elements.cameraOff.hidden = !isOff;
}

function hangUp() {
  intentionallyClosed = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  resetPeer();
  localStream?.getTracks().forEach((track) => track.stop());
  elements.localVideo.srcObject = null;
  elements.micButton.disabled = true;
  elements.cameraButton.disabled = true;
  elements.hangupButton.disabled = true;
  elements.cameraOff.hidden = false;
  setStatus('Звонок завершён', 'error');
  setWaiting('Звонок завершён', 'Обновите страницу, чтобы начать новый звонок.');
}

elements.micButton.addEventListener('click', () => toggleTrack('audio', elements.micButton));
elements.cameraButton.addEventListener('click', () => toggleTrack('video', elements.cameraButton));
elements.hangupButton.addEventListener('click', hangUp);
elements.copyLinkButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast('Ссылка скопирована');
  } catch {
    showToast('Не удалось скопировать ссылку');
  }
});

window.addEventListener('beforeunload', () => {
  intentionallyClosed = true;
  socket?.close();
  localStream?.getTracks().forEach((track) => track.stop());
});

async function init() {
  elements.micButton.disabled = true;
  elements.cameraButton.disabled = true;
  elements.hangupButton.disabled = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Браузер не поддерживается', 'error');
    setWaiting('WebRTC недоступен', 'Откройте страницу в современной версии Chrome, Firefox, Edge или Safari.');
    return;
  }
  if (await startMedia()) connectSignaling();
}

init();
