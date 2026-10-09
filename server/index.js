const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 30 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

/** @type {Map<string, Room>} */
const rooms = new Map();

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#120e1c', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  } catch {
    res.status(500).end();
  }
});

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O pour éviter les confusions
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', room.view(p.id));
  }
  for (const sid of room.screens) io.to(sid).emit('state', room.view(null, true));
}

function createRoom() {
  const code = makeCode();
  const room = new Room(code, broadcast);
  rooms.set(code, room);
  return room;
}

function bind(socket, room, player) {
  // un seul socket par joueur : l'ancien est détaché
  if (player.socketId && player.socketId !== socket.id) {
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.data = {};
      old.emit('replaced');
    }
  }
  socket.data = { code: room.code, pid: player.id };
  socket.join(room.code);
  room.setConnected(player.id, socket.id, true);
}

io.on('connection', (socket) => {
  socket.data = {};
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    return { room, pid: socket.data.pid };
  };

  socket.on('createRoom', ({ name, avatar } = {}, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const room = createRoom();
    const { player, error } = room.addPlayer(name, avatar);
    if (error) return cb({ error });
    bind(socket, room, player);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
  });

  socket.on('joinRoom', ({ code, name, avatar } = {}, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb({ error: 'Salle introuvable. Vérifie le code.' });
    const { player, error } = room.addPlayer(name, avatar);
    if (error) return cb({ error });
    bind(socket, room, player);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token, spectator: player.spectator });
  });

  socket.on('resume', ({ code, token } = {}, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && room.players.find((p) => p.token === token && !p.left);
    if (!player) return cb({ error: 'Session expirée' });
    bind(socket, room, player);
    cb({ ok: true, code: room.code, playerId: player.id });
  });

  socket.on('joinTv', ({ code } = {}, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb({ error: 'Salle introuvable.' });
    socket.data = { code: room.code, tv: true };
    socket.join(room.code);
    room.screens.add(socket.id);
    cb({ ok: true, code: room.code });
    socket.emit('state', room.view(null, true));
  });

  socket.on('updateSettings', (patch) => {
    const { room, pid } = ctx();
    if (room && pid === room.hostId) room.updateSettings(patch);
  });

  socket.on('kick', (targetId) => {
    const { room, pid } = ctx();
    if (!room || pid !== room.hostId || targetId === pid) return;
    const target = room.get(targetId);
    if (!target) return;
    if (target.socketId) {
      const s = io.sockets.sockets.get(target.socketId);
      if (s) {
        s.emit('kicked');
        s.leave(room.code);
        s.data = {};
      }
    }
    room.removePlayer(targetId);
  });

  socket.on('start', (a, b) => {
    const cb = typeof a === 'function' ? a : typeof b === 'function' ? b : () => {};
    const { room, pid } = ctx();
    if (!room || pid !== room.hostId) return cb({ error: "Seul l'hôte peut lancer la partie." });
    if (!room.canStart()) return cb({ error: 'Il faut au moins 2 joueurs connectés.' });
    if (!room.questionPool().length) return cb({ error: 'Choisis au moins une catégorie avec des questions.' });
    room.start();
    cb({ ok: true });
  });

  socket.on('answer', ({ text, joker } = {}) => {
    const { room, pid } = ctx();
    if (room) room.submitAnswer(pid, text, !!joker);
  });

  socket.on('passJoker', () => {
    const { room, pid } = ctx();
    if (room) room.passJoker(pid);
  });

  socket.on('decide', ({ pid: target, verdict } = {}) => {
    const { room, pid } = ctx();
    if (room) room.setDecision(pid, target, verdict);
  });

  socket.on('confirmValidation', () => {
    const { room, pid } = ctx();
    if (room) room.confirmValidation(pid);
  });

  socket.on('contest', (target) => {
    const { room, pid } = ctx();
    if (room) room.toggleContest(pid, target);
  });

  socket.on('advance', () => {
    const { room, pid } = ctx();
    if (room) room.advance(pid);
  });

  socket.on('skipTurn', () => {
    const { room, pid } = ctx();
    if (room) room.skipTurn(pid);
  });

  socket.on('backToLobby', () => {
    const { room, pid } = ctx();
    if (room) room.backToLobby(pid);
  });

  socket.on('react', (emoji) => {
    const { room, pid } = ctx();
    if (room && room.react(pid, emoji)) io.to(room.code).emit('reaction', { emoji, from: pid });
  });

  socket.on('leave', () => {
    const { room, pid } = ctx();
    if (!room) return;
    socket.leave(room.code);
    socket.data = {};
    if (pid) room.removePlayer(pid);
  });

  socket.on('disconnect', () => {
    const { room, pid } = ctx();
    if (!room) return;
    if (socket.data.tv) {
      room.screens.delete(socket.id);
      return;
    }
    const p = room.get(pid);
    if (p && p.socketId === socket.id) room.setConnected(pid, socket.id, false);
  });
});

// Nettoyage des salles abandonnées
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.connectedCount() === 0 && now - room.lastActivity > ROOM_IDLE_MS) {
      room.clearTimer();
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`🎤 Mastergoon en ligne sur http://localhost:${PORT}`);
});

module.exports = { server, io, rooms };
