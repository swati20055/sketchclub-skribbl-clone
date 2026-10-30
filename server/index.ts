import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import { makeSettings, Player, Room, type Settings } from './game.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const rooms = new Map<string, Room>();
const port = Number(process.env.PORT) || 3001;
const clientOrigin = process.env.CLIENT_ORIGIN;

app.use(cors(clientOrigin ? { origin: clientOrigin, credentials: true } : undefined));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.static(path.join(projectRoot, 'dist')));
app.get('*', (_request, response) => response.sendFile(path.join(projectRoot, 'dist', 'index.html')));

io.on('connection', (socket) => {
  socket.emit('rooms_list', listRooms());

  socket.on('create_room', (payload: { playerName?: string; settings?: Partial<Settings>; isPrivate?: boolean }, reply?: Reply) => {
    const name = cleanName(payload?.playerName);
    if (!name) return respond(reply, { error: 'Add a player name to create a room.' });
    leaveCurrentRoom(socket.id);
    const code = createCode();
    const player = new Player(socket.id, name, true);
    const room = new Room(io, code, player, makeSettings(payload.settings ?? {}), Boolean(payload.isPrivate));
    rooms.set(code, room);
    socket.join(room.id);
    room.updateLobby();
    io.emit('rooms_list', listRooms());
    respond(reply, { room: room.snapshot() });
  });

  socket.on('join_room', (payload: { roomId?: string; playerName?: string }, reply?: Reply) => {
    joinRoom(socket, payload, reply);
  });

  socket.on('join_random', (payload: { playerName?: string }, reply?: Reply) => {
    const room = [...rooms.values()].find((item) => !item.isPrivate && item.game.phase === 'lobby' && item.players.length < item.settings.maxPlayers);
    if (!room) return respond(reply, { error: 'No open rooms right now. Create one to get started.' });
    joinRoom(socket, { roomId: room.code, playerName: payload?.playerName }, reply);
  });

  socket.on('ready_toggle', () => {
    const room = roomFor(socket.id);
    const player = room?.players.find((item) => item.id === socket.id);
    if (!room || !player || room.game.phase !== 'lobby') return;
    player.ready = !player.ready;
    room.updateLobby();
  });

  socket.on('update_settings', (settings: Partial<Settings>) => {
    const room = roomFor(socket.id);
    if (!room || room.hostId !== socket.id || room.game.phase !== 'lobby') return;
    room.settings = makeSettings(settings);
    room.updateLobby();
    io.emit('rooms_list', listRooms());
  });

  socket.on('start_game', () => {
    const room = roomFor(socket.id);
    if (!room || room.hostId !== socket.id || room.game.phase !== 'lobby' || room.players.length < 2) return;
    if (room.players.some((player) => !player.ready)) {
      socket.emit('error_message', 'Everyone needs to be ready before the game can start.');
      return;
    }
    room.game.start();
    io.emit('rooms_list', listRooms());
  });

  socket.on('choose_word', (payload: { word?: string }) => {
    const room = roomFor(socket.id);
    if (!room?.game.chooseWord(socket.id, String(payload?.word ?? ''))) socket.emit('error_message', 'That word is not available. Choose one of the options shown.');
  });

  socket.on('draw_start', (payload: { point: { x: number; y: number }; color: string; size: number; tool: 'brush' | 'eraser' }) => {
    roomFor(socket.id)?.game.startStroke(socket.id, payload?.point, payload?.color, payload?.size, payload?.tool);
  });
  socket.on('draw_move', (payload: { point: { x: number; y: number } }) => roomFor(socket.id)?.game.moveStroke(socket.id, payload?.point));
  socket.on('draw_end', () => roomFor(socket.id)?.game.endStroke(socket.id));
  socket.on('canvas_clear', () => roomFor(socket.id)?.game.clearCanvas(socket.id));
  socket.on('draw_undo', () => roomFor(socket.id)?.game.undo(socket.id));
  socket.on('guess', (payload: { text?: string }) => roomFor(socket.id)?.game.guess(socket.id, String(payload?.text ?? '')));
  socket.on('chat', (payload: { text?: string }) => roomFor(socket.id)?.game.chat(socket.id, String(payload?.text ?? '')));
  socket.on('leave_room', () => leaveCurrentRoom(socket.id));
  socket.on('disconnect', () => leaveCurrentRoom(socket.id));
});

httpServer.listen(port, '0.0.0.0', () => console.log(`Sketchclub server listening on ${port}`));

type Reply = (result: { room?: ReturnType<Room['snapshot']>; error?: string }) => void;

function joinRoom(socket: Socket, payload: { roomId?: string; playerName?: string }, reply?: Reply) {
  const code = String(payload?.roomId ?? '').trim().toUpperCase();
  const name = cleanName(payload?.playerName);
  const room = rooms.get(code);
  if (!name) return respond(reply, { error: 'Add a player name before joining.' });
  if (!room) return respond(reply, { error: 'That room code was not found.' });
  if (room.game.phase !== 'lobby') return respond(reply, { error: 'This game has already started.' });
  if (room.players.length >= room.settings.maxPlayers) return respond(reply, { error: 'This room is full.' });
  if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return respond(reply, { error: 'That name is already in this room.' });
  leaveCurrentRoom(socket.id);
  const player = new Player(socket.id, name);
  room.players.push(player);
  socket.join(room.id);
  room.emit('player_joined', { player: { id: player.id, name: player.name }, players: room.playerList() });
  room.updateLobby();
  io.emit('rooms_list', listRooms());
  respond(reply, { room: room.snapshot() });
}

function roomFor(playerId: string) {
  return [...rooms.values()].find((room) => room.players.some((player) => player.id === playerId));
}

function leaveCurrentRoom(playerId: string) {
  const room = roomFor(playerId);
  if (!room) return;
  const leaving = room.players.find((player) => player.id === playerId);
  room.players.splice(0, room.players.length, ...room.players.filter((player) => player.id !== playerId));
  io.sockets.sockets.get(playerId)?.leave(room.id);
  if (room.hostId === playerId && room.players[0]) room.hostId = room.players[0].id;
  room.game.playerLeft(playerId);
  if (!room.players.length) rooms.delete(room.code);
  else {
    room.emit('player_left', { playerId, players: room.playerList() });
    room.updateLobby();
  }
  io.emit('rooms_list', listRooms());
  if (leaving) io.to(playerId).emit('left_room', { code: room.code });
}

function listRooms() {
  return [...rooms.values()].filter((room) => !room.isPrivate && room.game.phase === 'lobby').map((room) => ({
    code: room.code,
    players: room.players.length,
    maxPlayers: room.settings.maxPlayers,
    hostName: room.players.find((player) => player.id === room.hostId)?.name ?? 'Host',
  }));
}

function cleanName(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 18) : '';
}

function createCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function respond(reply: Reply | undefined, value: { room?: ReturnType<Room['snapshot']>; error?: string }) {
  if (reply) reply(value);
}
