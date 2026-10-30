import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const eventOnce = (socket, event, predicate = () => true, timeout = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, timeout);
  const handler = (value) => {
    if (!predicate(value)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(value);
  };
  socket.on(event, handler);
});

const request = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const host = io('http://localhost:3001', { reconnection: false });
const guest = io('http://localhost:3001', { reconnection: false });

try {
  await Promise.all([eventOnce(host, 'connect'), eventOnce(guest, 'connect')]);
  const created = await request(host, 'create_room', {
    playerName: 'Host',
    settings: { maxPlayers: 2, rounds: 2, drawTime: 30, wordCount: 2, hints: 0, wordMode: 'normal' },
    isPrivate: true,
  });
  assert.ok(created.room, created.error);
  const joined = await request(guest, 'join_room', { roomId: created.room.code, playerName: 'Guest' });
  assert.ok(joined.room, joined.error);
  assert.equal(joined.room.players.length, 2);

  guest.emit('ready_toggle');
  const optionsPromise = eventOnce(host, 'word_options');
  host.emit('start_game');
  const options = await optionsPromise;
  assert.equal(options.words.length, 2);
  const guestChoosing = await eventOnce(guest, 'game_state', (state) => state.phase === 'choosing');
  assert.equal(guestChoosing.word, null, 'the answer must remain private');

  let unauthorized = false;
  const guestStroke = eventOnce(guest, 'draw_data', () => true, 250);
  guest.emit('draw_start', { point: { x: 0.1, y: 0.2 }, color: '#18201b', size: 5, tool: 'brush' });
  try {
    await guestStroke;
    unauthorized = true;
  } catch {
    // No stroke event is expected from a non-drawer.
  }
  assert.equal(unauthorized, false, 'a non-drawer stroke must not broadcast');

  host.emit('choose_word', { word: options.words[0] });
  const drawingState = await eventOnce(guest, 'game_state', (state) => state.phase === 'drawing');
  assert.equal(drawingState.word, null);
  const strokeReceived = eventOnce(guest, 'draw_data', (data) => data.type === 'start');
  host.emit('draw_start', { point: { x: 0.2, y: 0.3 }, color: '#ef7357', size: 7, tool: 'brush' });
  await strokeReceived;

  const resultPromise = eventOnce(guest, 'guess_result', (result) => result.correct);
  const announcementPromise = eventOnce(guest, 'chat_message', (message) => message.text === 'guessed the word!');
  const roundEndPromise = eventOnce(guest, 'game_state', (state) => state.phase === 'roundEnd');
  guest.emit('guess', { text: `  ${options.words[0].toUpperCase()}  ` });
  const result = await resultPromise;
  await announcementPromise;
  const endState = await roundEndPromise;
  assert.ok(result.points > 0);
  assert.equal(endState.players.find((player) => player.name === 'Guest').score, result.points);
  const drawerPoints = endState.players.find((player) => player.name === 'Host').score;
  assert.ok(drawerPoints > 0);

  console.log(JSON.stringify({
    room: created.room.code,
    players: 2,
    privateAnswer: 'ok',
    drawerStrokeBroadcast: 'ok',
    nonDrawerDrawingBlocked: 'ok',
    caseTrimGuessScoring: result.points,
    drawerPoints,
  }, null, 2));
} finally {
  host.emit('leave_room');
  guest.emit('leave_room');
  host.disconnect();
  guest.disconnect();
}
