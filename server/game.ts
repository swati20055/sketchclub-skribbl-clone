import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';

export type WordMode = 'normal' | 'hidden' | 'combination';
export type Settings = {
  maxPlayers: number;
  rounds: number;
  drawTime: number;
  wordCount: number;
  hints: number;
  wordMode: WordMode;
};
export type Point = { x: number; y: number };
export type Stroke = {
  id: string;
  color: string;
  size: number;
  tool: 'brush' | 'eraser';
  points: Point[];
};

const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 8,
  rounds: 3,
  drawTime: 80,
  wordCount: 3,
  hints: 2,
  wordMode: 'normal',
};

const WORDS = [
  'giraffe', 'octopus', 'penguin', 'hedgehog', 'flamingo', 'dolphin', 'butterfly', 'kangaroo',
  'umbrella', 'telescope', 'skateboard', 'teapot', 'crown', 'camera', 'lighthouse', 'backpack',
  'juggling', 'sneezing', 'surfing', 'gardening', 'moonwalking', 'sleepwalking', 'whistling', 'skipping',
];

export class Player {
  score = 0;
  ready: boolean;

  constructor(public id: string, public name: string, ready = false) {
    this.ready = ready;
  }
}

export class Room {
  readonly id: string;
  readonly players: Player[] = [];
  readonly game: Game;
  settings: Settings;
  hostId: string;

  constructor(
    public io: Server,
    public code: string,
    host: Player,
    settings: Partial<Settings>,
    public isPrivate: boolean,
  ) {
    this.id = `room:${code}`;
    this.hostId = host.id;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.players.push(host);
    this.game = new Game(this);
  }

  emit(event: string, payload: unknown) {
    this.io.to(this.id).emit(event, payload);
  }

  emitPlayer(playerId: string, event: string, payload: unknown) {
    this.io.to(playerId).emit(event, payload);
  }

  playerList() {
    return this.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      ready: player.ready,
      isHost: player.id === this.hostId,
    }));
  }

  snapshot() {
    return {
      id: this.id,
      code: this.code,
      isPrivate: this.isPrivate,
      hostId: this.hostId,
      players: this.playerList(),
      settings: this.settings,
    };
  }

  sendState() {
    for (const player of this.players) {
      this.emitPlayer(player.id, 'game_state', this.game.stateFor(player.id));
    }
  }

  updateLobby() {
    this.emit('room_updated', this.snapshot());
  }
}

export class Game {
  phase: 'lobby' | 'choosing' | 'drawing' | 'roundEnd' | 'gameOver' = 'lobby';
  round = 0;
  drawerId: string | null = null;
  word: string | null = null;
  wordOptions: string[] = [];
  strokes: Stroke[] = [];
  timeLeft = 0;
  hintsRevealed = 0;
  guessedIds = new Set<string>();
  private turnNumber = 0;
  private turnOrder: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private nextRoundTimer: NodeJS.Timeout | undefined;
  private lastStrokeId: string | undefined;

  constructor(private room: Room) {}

  stateFor(playerId: string) {
    const revealAnswer = this.phase === 'roundEnd' || this.phase === 'gameOver';
    return {
      phase: this.phase,
      round: this.round,
      totalRounds: this.room.settings.rounds,
      drawerId: this.drawerId,
      word: playerId === this.drawerId || revealAnswer ? this.word : null,
      wordHint: this.word ? this.hintFor(playerId) : '',
      timeLeft: this.timeLeft,
      hintsRevealed: this.hintsRevealed,
      strokes: this.strokes,
      guessedIds: [...this.guessedIds],
      players: this.room.playerList(),
    };
  }

  start() {
    this.clearTimers();
    this.turnOrder = this.room.players.map((player) => player.id);
    this.turnNumber = 0;
    for (const player of this.room.players) player.score = 0;
    this.nextTurn();
  }

  chooseWord(playerId: string, rawWord: string) {
    if (this.phase !== 'choosing' || playerId !== this.drawerId) return false;
    const selected = this.wordOptions.find((option) => normalize(option) === normalize(rawWord));
    if (!selected) return false;
    this.word = selected;
    this.phase = 'drawing';
    this.timeLeft = this.room.settings.drawTime;
    this.hintsRevealed = 0;
    this.strokes = [];
    this.lastStrokeId = undefined;
    this.room.emit('word_chosen', { drawerId: this.drawerId, round: this.round });
    this.room.sendState();
    this.timer = setInterval(() => this.tick(), 1000);
    return true;
  }

  startStroke(playerId: string, point: Point, color: string, size: number, tool: 'brush' | 'eraser') {
    if (!this.canDraw(playerId)) return;
    const stroke: Stroke = {
      id: randomUUID(),
      color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#18201b',
      size: Math.max(2, Math.min(42, Number(size) || 5)),
      tool: tool === 'eraser' ? 'eraser' : 'brush',
      points: [cleanPoint(point)],
    };
    this.strokes.push(stroke);
    this.lastStrokeId = stroke.id;
    this.room.emit('draw_data', { type: 'start', stroke });
  }

  moveStroke(playerId: string, point: Point) {
    if (!this.canDraw(playerId) || !this.lastStrokeId) return;
    const stroke = this.strokes.find((item) => item.id === this.lastStrokeId);
    if (!stroke) return;
    const safePoint = cleanPoint(point);
    stroke.points.push(safePoint);
    this.room.emit('draw_data', { type: 'move', strokeId: stroke.id, point: safePoint });
  }

  endStroke(playerId: string) {
    if (playerId !== this.drawerId) return;
    this.lastStrokeId = undefined;
    this.room.emit('draw_data', { type: 'end' });
  }

  clearCanvas(playerId: string) {
    if (!this.canDraw(playerId)) return;
    this.strokes = [];
    this.lastStrokeId = undefined;
    this.room.emit('canvas_clear', {});
  }

  undo(playerId: string) {
    if (!this.canDraw(playerId)) return;
    this.strokes.pop();
    this.lastStrokeId = undefined;
    this.room.emit('draw_undo', { strokes: this.strokes });
  }

  guess(playerId: string, text: string) {
    if (this.phase !== 'drawing' || playerId === this.drawerId || !this.word) return;
    const player = this.room.players.find((item) => item.id === playerId);
    if (!player || this.guessedIds.has(playerId)) return;
    const guess = text.trim().slice(0, 100);
    if (!guess) return;
    const answer = normalize(this.word);
    const normalizedGuess = normalize(guess);
    const correct = normalizedGuess === answer;
    const close = !correct && answer.length > 3 && answer.startsWith(normalizedGuess) && normalizedGuess.length >= 3;
    if (correct) {
      this.guessedIds.add(playerId);
      const first = this.guessedIds.size === 1;
      const points = first ? 100 + this.timeLeft : 50 + Math.floor(this.timeLeft / 2);
      player.score += points;
      const drawer = this.room.players.find((item) => item.id === this.drawerId);
      if (drawer) drawer.score += first ? 25 : 10;
      this.room.emit('guess_result', { correct: true, playerId, playerName: player.name, points, first });
      this.room.emit('chat_message', {
        playerId,
        playerName: player.name,
        text: 'guessed the word!',
        timestamp: Date.now(),
      });
      const eligibleGuessers = this.room.players.filter((item) => item.id !== this.drawerId).length;
      if (this.guessedIds.size >= eligibleGuessers) this.endRound();
      else this.room.sendState();
      return;
    }
    this.room.emitPlayer(playerId, 'guess_result', { correct: false, close, playerId, playerName: player.name, points: 0 });
    this.room.emit('chat_message', {
      playerId,
      playerName: player.name,
      text: guess,
      isGuess: true,
      close,
      timestamp: Date.now(),
    });
  }

  chat(playerId: string, text: string) {
    const player = this.room.players.find((item) => item.id === playerId);
    const message = text.trim().slice(0, 240);
    if (!player || !message || this.phase === 'gameOver') return;
    if (this.phase === 'drawing' && playerId === this.drawerId) return;
    this.room.emit('chat_message', { playerId, playerName: player.name, text: message, timestamp: Date.now() });
  }

  playerLeft(playerId: string) {
    if (this.phase === 'lobby' || this.phase === 'gameOver') return;
    if (this.room.players.length < 2) {
      this.finishGame();
      return;
    }
    if (playerId === this.drawerId) this.endRound();
    else {
      this.guessedIds.delete(playerId);
      const eligible = this.room.players.filter((player) => player.id !== this.drawerId).length;
      if (this.phase === 'drawing' && this.guessedIds.size >= eligible) this.endRound();
      else this.room.sendState();
    }
  }

  private canDraw(playerId: string) {
    return this.phase === 'drawing' && playerId === this.drawerId;
  }

  private nextTurn() {
    this.clearTimers();
    if (this.turnOrder.length < 2 || this.turnNumber >= this.room.settings.rounds * this.turnOrder.length) {
      this.finishGame();
      return;
    }
    this.round = Math.floor(this.turnNumber / this.turnOrder.length) + 1;
    let nextDrawerId = this.turnOrder[this.turnNumber % this.turnOrder.length] ?? null;
    while (nextDrawerId && !this.room.players.some((player) => player.id === nextDrawerId)) {
      this.turnNumber += 1;
      if (this.turnNumber >= this.room.settings.rounds * this.turnOrder.length) {
        this.finishGame();
        return;
      }
      this.round = Math.floor(this.turnNumber / this.turnOrder.length) + 1;
      nextDrawerId = this.turnOrder[this.turnNumber % this.turnOrder.length] ?? null;
    }
    this.drawerId = nextDrawerId;
    if (!this.drawerId) {
      this.finishGame();
      return;
    }
    this.phase = 'choosing';
    this.word = null;
    this.strokes = [];
    this.guessedIds.clear();
    this.timeLeft = this.room.settings.drawTime;
    this.hintsRevealed = 0;
    this.wordOptions = pickWords(this.room.settings.wordCount, this.room.settings.wordMode);
    this.room.emit('round_start', {
      drawerId: this.drawerId,
      round: this.round,
      totalRounds: this.room.settings.rounds,
      drawTime: this.room.settings.drawTime,
    });
    this.room.emitPlayer(this.drawerId, 'word_options', { words: this.wordOptions });
    this.room.sendState();
    this.timer = setTimeout(() => this.chooseWord(this.drawerId ?? '', this.wordOptions[0] ?? ''), 20000);
  }

  private tick() {
    if (this.phase !== 'drawing') return;
    this.timeLeft = Math.max(0, this.timeLeft - 1);
    const hintCount = this.room.settings.hints;
    if (hintCount > this.hintsRevealed && this.timeLeft <= this.room.settings.drawTime * (hintCount - this.hintsRevealed) / (hintCount + 1)) {
      this.hintsRevealed += 1;
      this.room.emit('hint_revealed', { wordHint: this.hintFor(''), hintsRevealed: this.hintsRevealed });
    }
    this.room.sendState();
    if (this.timeLeft <= 0) this.endRound();
  }

  private endRound() {
    if (this.phase !== 'drawing' && this.phase !== 'choosing') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lastStrokeId = undefined;
    this.phase = 'roundEnd';
    this.room.emit('round_end', {
      word: this.word ?? this.wordOptions[0] ?? '',
      scores: this.room.playerList().sort((a, b) => b.score - a.score),
      nextDrawer: this.turnOrder[(this.turnNumber + 1) % this.turnOrder.length],
    });
    this.room.sendState();
    this.nextRoundTimer = setTimeout(() => {
      this.turnNumber += 1;
      this.nextTurn();
    }, 5000);
  }

  private finishGame() {
    this.clearTimers();
    this.phase = 'gameOver';
    const leaderboard = this.room.playerList().sort((a, b) => b.score - a.score);
    this.room.emit('game_over', { winner: leaderboard[0] ?? null, leaderboard });
    this.room.sendState();
  }

  private hintFor(playerId: string) {
    if (!this.word) return '';
    if (playerId === this.drawerId) return this.word;
    if (this.room.settings.wordMode === 'hidden') return this.word.replace(/[a-z]/gi, '_');
    let visibleIndex = 0;
    return this.word.split('').map((character) => {
      if (!/[a-z]/i.test(character)) return character;
      const show = visibleIndex < this.hintsRevealed;
      visibleIndex += 1;
      return show ? character : '_';
    }).join(' ');
  }

  private clearTimers() {
    if (this.timer) clearInterval(this.timer);
    if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer);
    this.timer = undefined;
    this.nextRoundTimer = undefined;
  }
}

export function makeSettings(input: Partial<Settings>): Settings {
  const validMode: WordMode = input.wordMode === 'hidden' || input.wordMode === 'combination' ? input.wordMode : 'normal';
  return {
    maxPlayers: clamp(input.maxPlayers, 2, 20, DEFAULT_SETTINGS.maxPlayers),
    rounds: clamp(input.rounds, 2, 10, DEFAULT_SETTINGS.rounds),
    drawTime: clamp(input.drawTime, 15, 240, DEFAULT_SETTINGS.drawTime),
    wordCount: clamp(input.wordCount, 1, 5, DEFAULT_SETTINGS.wordCount),
    hints: clamp(input.hints, 0, 5, DEFAULT_SETTINGS.hints),
    wordMode: validMode,
  };
}

export function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function cleanPoint(point: Point): Point {
  return {
    x: Math.max(0, Math.min(1, Number(point?.x) || 0)),
    y: Math.max(0, Math.min(1, Number(point?.y) || 0)),
  };
}

function pickWords(count: number, mode: WordMode) {
  const shuffled = [...WORDS].sort(() => Math.random() - 0.5);
  if (mode === 'combination' && count > 1) {
    return shuffled.slice(0, count).map((word, index) => index % 2 ? `${word} + ${shuffled[index + count] ?? 'star'}` : word);
  }
  return shuffled.slice(0, count);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}
