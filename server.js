// Planning Poker do time — servidor (Express + Socket.IO, salas em memória)
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 200 * 1024 });

app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
// Qualquer /sala/XXXX entrega o mesmo front-end
app.get('/sala/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const DECKS = {
  horas: { label: 'Horas', unit: 'h', cards: ['0.5', '1', '2', '4', '6', '8', '12', '16', '24', '32', '40', '?', '☕'] },
  fibonacci: { label: 'Fibonacci', unit: '', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'] },
  fibmod: { label: 'Fibonacci modificado', unit: '', cards: ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  tshirt: { label: 'Camiseta', unit: '', cards: ['PP', 'P', 'M', 'G', 'GG', '?', '☕'] },
};

const rooms = new Map();
const OFFLINE_GRACE_MS = 60 * 1000;          // mantém o jogador 1 min após cair (reconexão)
const EMPTY_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // sala vazia some depois de 12h

const MAX_AVATAR_CHARS = 80 * 1024; // foto já chega reduzida (≈96px) do navegador

// Avatar: foto (data URL) ou "emoji:<emoji>:<#cor>"
const cleanAvatar = a => (typeof a === 'string' && a.length <= MAX_AVATAR_CHARS &&
  (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a) ||
   /^emoji:[^:<>"'&]{1,16}:#[0-9a-fA-F]{6}$/.test(a))) ? a : null;

const clean = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

function sanitizeCards(list) {
  const out = [];
  for (const c of list || []) {
    const v = clean(c, 6);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

function parseCustomValue(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!(n >= 0 && n <= 9999)) return null;
  return String(n);
}

function newRoomId() {
  let id;
  do { id = crypto.randomBytes(4).toString('hex'); } while (rooms.has(id));
  return id;
}

function publicState(room, viewerId) {
  const players = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    spectator: p.spectator,
    online: p.sockets.size > 0,
    voted: p.vote !== null,
    vote: room.revealed || p.id === viewerId ? p.vote : null, // cada um vê o próprio voto
    host: p.id === room.hostId,
    avatarRev: p.avatarRev, // a foto vai num evento separado ('avatars') para não pesar cada atualização
  }));
  return {
    id: room.id,
    name: room.name,
    deck: room.deck,
    unit: room.unit,
    allowCustom: room.allowCustom,
    revealed: room.revealed,
    story: room.story,
    history: room.history,
    hostId: room.hostId,
    autoReveal: room.autoReveal,
    timer: room.timer, // { endsAt, duration } em horário do servidor, ou null
    expired: room.timerExpired,
    now: Date.now(),
    players,
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    const st = publicState(room, p.id);
    for (const sid of p.sockets) io.to(sid).emit('state', st);
  }
}

function sendAvatars(room) {
  const map = {};
  for (const p of room.players.values()) if (p.avatar) map[p.id] = p.avatar;
  io.to(room.id).emit('avatars', map);
}

function stopTimer(room) {
  clearTimeout(room.timerHandle);
  room.timerHandle = null;
  room.timer = null;
  room.timerExpired = false;
}

function startTimer(room, seconds) {
  clearTimeout(room.timerHandle);
  const ms = seconds * 1000;
  room.timer = { endsAt: Date.now() + ms, duration: ms };
  room.timerExpired = false;
  room.timerHandle = setTimeout(() => onTimerEnd(room), ms);
}

function onTimerEnd(room) {
  room.timerHandle = null;
  room.timer = null;
  const anyVote = [...room.players.values()].some(p => p.vote !== null);
  if (room.autoReveal && anyVote && !room.revealed) room.revealed = true;
  else room.timerExpired = !room.revealed;
  broadcast(room);
}

function reveal(room) {
  stopTimer(room);
  room.revealed = true;
}

function resetRound(room) {
  stopTimer(room);
  room.revealed = false;
  for (const p of room.players.values()) p.vote = null;
}

function touch(room) {
  room.updatedAt = Date.now();
}

io.on('connection', socket => {
  let room = null;
  let clientId = null;

  const me = () => room && room.players.get(clientId);
  const isHost = () => room && room.hostId === clientId;

  socket.on('decks', cb => typeof cb === 'function' && cb(DECKS));

  socket.on('create_room', (data, cb) => {
    if (typeof cb !== 'function') return;
    const preset = DECKS[data?.deckType];
    let cards = preset ? preset.cards : sanitizeCards(data?.cards);
    if (!cards.length) cards = DECKS.horas.cards;
    const id = newRoomId();
    rooms.set(id, {
      id,
      name: clean(data?.name, 60) || 'Planning Poker',
      deck: cards,
      unit: preset ? preset.unit : clean(data?.unit, 4),
      allowCustom: data?.allowCustom !== false,
      autoReveal: true,
      timer: null,
      timerHandle: null,
      timerExpired: false,
      revealed: false,
      story: '',
      history: [],
      hostId: null,
      players: new Map(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    cb({ ok: true, id });
  });

  socket.on('join', (data, cb) => {
    const r = rooms.get(clean(data?.roomId, 20));
    if (!r) return typeof cb === 'function' && cb({ ok: false, error: 'Sala não encontrada. Ela pode ter expirado.' });
    const name = clean(data?.name, 30);
    if (!name) return typeof cb === 'function' && cb({ ok: false, error: 'Informe seu nome.' });
    room = r;
    clientId = clean(data?.clientId, 64) || crypto.randomUUID();
    const avatar = cleanAvatar(data?.avatar);
    let p = room.players.get(clientId);
    if (!p) {
      p = { id: clientId, name, spectator: !!data?.spectator, vote: null, sockets: new Set(), leaveTimer: null, avatar, avatarRev: avatar ? 1 : 0 };
      room.players.set(clientId, p);
    } else {
      p.name = name;
      p.spectator = !!data?.spectator;
      if (p.spectator) p.vote = null;
      if (avatar !== p.avatar) { p.avatar = avatar; p.avatarRev++; }
    }
    clearTimeout(p.leaveTimer);
    p.sockets.add(socket.id);
    if (!room.hostId || !room.players.has(room.hostId)) room.hostId = clientId;
    socket.join(room.id);
    touch(room);
    if (typeof cb === 'function') cb({ ok: true, clientId });
    broadcast(room);
    sendAvatars(room);
  });

  socket.on('vote', value => {
    const p = me();
    if (!p || p.spectator || room.revealed) return;
    let v = null;
    if (value !== null && value !== undefined) {
      const s = String(value);
      if (room.deck.includes(s)) v = s;
      else if (room.allowCustom) v = parseCustomValue(s);
      if (v === null) return; // valor inválido: ignora
    }
    p.vote = p.vote === v ? null : v; // clicar de novo na mesma carta desmarca
    touch(room);
    broadcast(room);
  });

  socket.on('reveal', () => {
    if (!me() || room.revealed) return;
    reveal(room);
    touch(room);
    broadcast(room);
  });

  socket.on('new_round', () => {
    if (!me()) return;
    resetRound(room);
    touch(room);
    broadcast(room);
  });

  // Timer de votação: qualquer participante pode iniciar, somar tempo ou parar
  socket.on('timer_start', seconds => {
    const n = Math.round(Number(seconds));
    if (!me() || room.revealed || !(n >= 5 && n <= 3600)) return;
    startTimer(room, n);
    touch(room);
    broadcast(room);
  });

  socket.on('timer_add', seconds => {
    const n = Math.round(Number(seconds));
    if (!me() || !room.timer || !(n >= 5 && n <= 600)) return;
    const left = Math.max(0, room.timer.endsAt - Date.now());
    const duration = room.timer.duration + n * 1000;
    startTimer(room, Math.min(3600, Math.round((left + n * 1000) / 1000)));
    room.timer.duration = Math.min(duration, 3600 * 1000);
    broadcast(room);
  });

  socket.on('timer_stop', () => {
    if (!me()) return;
    stopTimer(room);
    broadcast(room);
  });

  socket.on('set_story', text => {
    if (!me()) return;
    room.story = clean(text, 200);
    touch(room);
    broadcast(room);
  });

  // Registra a estimativa final da tarefa atual no histórico e inicia nova rodada
  socket.on('save_estimate', data => {
    if (!me()) return;
    const value = clean(data?.value, 10);
    if (!value) return;
    room.history.unshift({
      story: room.story || `Tarefa ${room.history.length + 1}`,
      value,
      unit: room.unit,
      votes: [...room.players.values()].filter(p => p.vote !== null).map(p => ({ name: p.name, vote: p.vote })),
      at: Date.now(),
    });
    room.history = room.history.slice(0, 200);
    room.story = '';
    resetRound(room);
    touch(room);
    broadcast(room);
  });

  socket.on('remove_history', idx => {
    if (!me() || !Number.isInteger(idx)) return;
    room.history.splice(idx, 1);
    broadcast(room);
  });

  socket.on('update_settings', data => {
    if (!isHost()) return;
    const cards = sanitizeCards(data?.cards);
    if (cards.length) room.deck = cards;
    if (typeof data?.unit === 'string') room.unit = clean(data.unit, 4);
    if (typeof data?.allowCustom === 'boolean') room.allowCustom = data.allowCustom;
    if (typeof data?.autoReveal === 'boolean') room.autoReveal = data.autoReveal;
    if (typeof data?.name === 'string' && clean(data.name)) room.name = clean(data.name);
    // votos que não existem mais no baralho (e não são numéricos válidos) são descartados
    for (const p of room.players.values()) {
      if (p.vote !== null && !room.deck.includes(p.vote) && !(room.allowCustom && parseCustomValue(p.vote) !== null)) p.vote = null;
    }
    touch(room);
    broadcast(room);
  });

  socket.on('make_host', id => {
    if (!isHost() || !room.players.has(id)) return;
    room.hostId = id;
    broadcast(room);
  });

  socket.on('kick', id => {
    if (!isHost() || id === clientId) return;
    const p = room.players.get(id);
    if (!p) return;
    for (const sid of p.sockets) io.to(sid).emit('kicked');
    room.players.delete(id);
    broadcast(room);
  });

  socket.on('toggle_spectator', () => {
    const p = me();
    if (!p) return;
    p.spectator = !p.spectator;
    p.vote = null;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const p = me();
    if (!p) return;
    p.sockets.delete(socket.id);
    if (p.sockets.size > 0) return;
    const r = room;
    broadcast(r);
    p.leaveTimer = setTimeout(() => {
      if (p.sockets.size > 0) return;
      r.players.delete(p.id);
      if (r.hostId === p.id) {
        const next = [...r.players.values()].find(x => x.sockets.size > 0);
        r.hostId = next ? next.id : null;
      }
      touch(r);
      broadcast(r);
    }, OFFLINE_GRACE_MS);
  });
});

// Limpeza de salas vazias antigas
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.players.size === 0 && now - r.updatedAt > EMPTY_ROOM_TTL_MS) { stopTimer(r); rooms.delete(id); }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Planning Poker rodando em http://localhost:${PORT}`));
