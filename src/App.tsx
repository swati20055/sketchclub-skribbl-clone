import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ArrowLeft, Brush, Check, Clock3, Copy, Crown, DoorOpen, Eraser, Eye,
  Gamepad2, LockKeyhole, MessageCircle, Minus, Paintbrush, Plus,
  RotateCcw, Send, Sparkles, Trophy, Users, WandSparkles,
} from 'lucide-react';

type Player = { id: string; name: string; score: number; ready: boolean; isHost: boolean };
type Settings = { maxPlayers: number; rounds: number; drawTime: number; wordCount: number; hints: number; wordMode: 'normal' | 'hidden' | 'combination' };
type Room = { id: string; code: string; isPrivate: boolean; hostId: string; players: Player[]; settings: Settings };
type Stroke = { id: string; color: string; size: number; tool: 'brush' | 'eraser'; points: { x: number; y: number }[] };
type GameState = { phase: 'lobby' | 'choosing' | 'drawing' | 'roundEnd' | 'gameOver'; round: number; totalRounds: number; drawerId: string | null; word: string | null; wordHint: string; timeLeft: number; hintsRevealed: number; strokes: Stroke[]; guessedIds: string[]; players: Player[] };
type ChatMessage = { playerId: string; playerName: string; text: string; isGuess?: boolean; close?: boolean; timestamp: number };
type PublicRoom = { code: string; players: number; maxPlayers: number; hostName: string };

const palette = ['#18201b', '#ef7357', '#f3bb43', '#56a77c', '#63a7c7', '#a28bd2', '#f4f0e5'];
const defaults: Settings = { maxPlayers: 8, rounds: 3, drawTime: 80, wordCount: 3, hints: 2, wordMode: 'normal' };

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [wordOptions, setWordOptions] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState(() => new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '');
  const [privateRoom, setPrivateRoom] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    const socket = io({ autoConnect: true });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('rooms_list', (items: PublicRoom[]) => setRooms(items));
    socket.on('room_updated', (value: Room) => setRoom(value));
    socket.on('game_state', (value: GameState) => setGame(value));
    socket.on('word_options', (value: { words: string[] }) => setWordOptions(value.words));
    socket.on('round_start', () => { setMessages([]); setNotice(''); });
    socket.on('draw_data', (value: { type: string; stroke?: Stroke; strokeId?: string; point?: { x: number; y: number } }) => {
      setGame((current) => {
        if (!current) return current;
        if (value.type === 'start' && value.stroke) return { ...current, strokes: [...current.strokes, value.stroke] };
        if (value.type === 'move' && value.strokeId && value.point) return {
          ...current,
          strokes: current.strokes.map((stroke) => stroke.id === value.strokeId ? { ...stroke, points: [...stroke.points, value.point!] } : stroke),
        };
        return current;
      });
    });
    socket.on('canvas_clear', () => setGame((current) => current ? { ...current, strokes: [] } : current));
    socket.on('draw_undo', (value: { strokes: Stroke[] }) => setGame((current) => current ? { ...current, strokes: value.strokes } : current));
    socket.on('chat_message', (message: ChatMessage) => setMessages((current) => [...current.slice(-70), message]));
    socket.on('guess_result', (result: { correct: boolean; close?: boolean; points: number }) => {
      if (result.correct) setNotice(`Correct guess! +${result.points} points`);
      else if (result.close) setNotice('So close! That guess starts the word.');
    });
    socket.on('hint_revealed', () => setNotice('A new letter was revealed.'));
    socket.on('round_end', (result: { word: string }) => setNotice(`The word was ${result.word}`));
    socket.on('game_over', (result: { winner: Player | null }) => setNotice(result.winner ? `${result.winner.name} takes the crown!` : 'Game over'));
    socket.on('error_message', (message: string) => setNotice(message));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const activePlayer = room?.players.find((player) => player.id === socketRef.current?.id);
  const isDrawer = game?.drawerId === socketRef.current?.id;

  function showRoom(value: Room) {
    setRoom(value);
    setGame(null);
    setWordOptions([]);
    setMessages([]);
    setNotice('');
    window.history.replaceState({}, '', `${window.location.pathname}?room=${value.code}`);
  }

  function submitRoom(action: 'create_room' | 'join_room' | 'join_random', payload: Record<string, unknown>) {
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) {
      setNameError('Enter at least 2 characters for your name.');
      return;
    }
    setNameError('');
    socketRef.current?.emit(action, { ...payload, playerName: cleanName }, (result: { room?: Room; error?: string }) => {
      if (result.error) setNotice(result.error);
      else if (result.room) showRoom(result.room);
    });
  }

  function returnHome() {
    socketRef.current?.emit('leave_room');
    setRoom(null);
    setGame(null);
    setMessages([]);
    setNotice('');
    window.history.replaceState({}, '', window.location.pathname);
  }

  async function copyInvite() {
    const link = `${window.location.origin}${window.location.pathname}?room=${room?.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice(`Invite code: ${room?.code}`);
    }
  }

  if (room && game && game.phase !== 'lobby') {
    return <GameScreen room={room} game={game} name={activePlayer?.name ?? name} isDrawer={Boolean(isDrawer)} wordOptions={wordOptions} messages={messages} notice={notice} socket={socketRef.current} onLeave={returnHome} onCopyInvite={copyInvite} copied={copied} />;
  }
  if (room) {
    return <LobbyScreen room={room} playerId={socketRef.current?.id ?? ''} settings={room.settings} notice={notice} onReady={() => socketRef.current?.emit('ready_toggle')} onStart={() => socketRef.current?.emit('start_game')} onSettings={(next) => socketRef.current?.emit('update_settings', next)} onLeave={returnHome} onCopyInvite={copyInvite} copied={copied} />;
  }

  return <HomeScreen connected={connected} name={name} onName={(value) => { setName(value); setNameError(''); }} nameError={nameError} joinCode={joinCode} onJoinCode={setJoinCode} rooms={rooms} privateRoom={privateRoom} onPrivateRoom={setPrivateRoom} settings={settings} onSettings={setSettings} notice={notice} onCreate={() => submitRoom('create_room', { settings, isPrivate: privateRoom })} onJoin={() => submitRoom('join_room', { roomId: joinCode })} onRandom={() => submitRoom('join_random', {})} onJoinRoom={(code) => submitRoom('join_room', { roomId: code })} />;
}

function HomeScreen(props: {
  connected: boolean; name: string; onName: (value: string) => void; nameError: string;
  joinCode: string; onJoinCode: (value: string) => void; rooms: PublicRoom[];
  privateRoom: boolean; onPrivateRoom: (value: boolean) => void; settings: Settings;
  onSettings: (value: Settings) => void; notice: string; onCreate: () => void;
  onJoin: () => void; onRandom: () => void; onJoinRoom: (code: string) => void;
}) {
  return <main className="home-shell">
    <header className="topbar"><a className="brand" href="#" aria-label="Sketchclub home"><span className="brand-mark"><Paintbrush size={20} /></span><span>sketchclub<span className="brand-period">.</span></span></a><div className="topbar-right"><span className={`connection ${props.connected ? 'is-online' : ''}`}><i />{props.connected ? 'SERVER LIVE' : 'CONNECTING'}</span><span className="topbar-caption">A little imagination goes a long way</span></div></header>
    <section className="home-layout">
      <div className="welcome-panel"><div className="eyebrow"><Sparkles size={14} /> THE DRAWING PARTY GAME</div><h1>Make a mess.<br /><span>Make a guess.</span></h1><p>One word. One canvas. A room full of questionable artists.</p><div className="scribble-art" aria-hidden="true"><div className="doodle-sun"><span /></div><div className="doodle-word">hmm...</div><div className="doodle-cup"><span /><i /></div><div className="doodle-line" /><div className="doodle-note">drawn by<br />someone's cousin</div></div><div className="welcome-foot"><span className="avatar-stack"><i>M</i><i>J</i><i>A</i><b>+</b></span><span>Better with your people</span></div></div>
      <div className="entry-column">
        <div className="entry-card"><div className="card-heading"><div><span className="step-label">FIRST, THE IMPORTANT BIT</span><h2>What should we call you?</h2></div><span className="heading-icon"><Users size={18} /></span></div><label className="field-label" htmlFor="player-name">YOUR NAME</label><input id="player-name" className={`text-field ${props.nameError ? 'field-error' : ''}`} value={props.name} onChange={(event) => props.onName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') props.onCreate(); }} maxLength={18} placeholder="e.g. Doodlebug" autoComplete="nickname" />{props.nameError && <p className="field-hint error-text">{props.nameError}</p>}<div className="action-divider"><span>START SOMETHING</span></div><div className="private-toggle-row"><span><LockKeyhole size={15} /> Private room</span><button className={`switch ${props.privateRoom ? 'switch-on' : ''}`} role="switch" aria-checked={props.privateRoom} onClick={() => props.onPrivateRoom(!props.privateRoom)}><i /></button></div>{props.privateRoom && <p className="field-hint">Only people with your invite link can join.</p>}<button className="primary-button create-button" onClick={props.onCreate}><span><Gamepad2 size={18} /> Create a room</span><span className="button-arrow">&#8594;</span></button><div className="join-row"><input aria-label="Room code" className="text-field code-field" value={props.joinCode} onChange={(event) => props.onJoinCode(event.target.value.toUpperCase().slice(0, 5))} onKeyDown={(event) => { if (event.key === 'Enter') props.onJoin(); }} placeholder="ENTER CODE" maxLength={5} /><button className="outline-button" onClick={props.onJoin}><DoorOpen size={16} /> Join</button></div><button className="random-button" onClick={props.onRandom}><WandSparkles size={15} /> Find an open room</button>{props.notice && <div className="notice" role="status">{props.notice}</div>}</div>
        <div className="settings-card"><div className="settings-heading"><div><span className="step-label">HOST CONTROLS</span><h3>Room settings</h3></div><span className="settings-small">SET BEFORE YOU GO</span></div><div className="settings-grid"><SettingStepper label="Players" value={props.settings.maxPlayers} min={2} max={20} suffix="players" onChange={(value) => props.onSettings({ ...props.settings, maxPlayers: value })} /><SettingStepper label="Rounds" value={props.settings.rounds} min={2} max={10} suffix="rounds" onChange={(value) => props.onSettings({ ...props.settings, rounds: value })} /><SettingStepper label="Draw time" value={props.settings.drawTime} min={15} max={240} step={15} suffix="sec" onChange={(value) => props.onSettings({ ...props.settings, drawTime: value })} /><SettingStepper label="Word choices" value={props.settings.wordCount} min={1} max={5} suffix="words" onChange={(value) => props.onSettings({ ...props.settings, wordCount: value })} /></div><div className="settings-bottom"><label htmlFor="hint-count">Hints</label><select id="hint-count" value={props.settings.hints} onChange={(event) => props.onSettings({ ...props.settings, hints: Number(event.target.value) })}><option value={0}>Off</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} hints</option>)}</select><label htmlFor="word-mode">Word mode</label><select id="word-mode" value={props.settings.wordMode} onChange={(event) => props.onSettings({ ...props.settings, wordMode: event.target.value as Settings['wordMode'] })}><option value="normal">Normal</option><option value="hidden">Hidden</option><option value="combination">Combination</option></select></div></div>
      </div>
      <aside className="rooms-panel"><div className="rooms-heading"><div><span className="step-label">JUMP RIGHT IN</span><h2>Open rooms <span className="live-dot" /></h2></div><span className="room-count">{props.rooms.length}</span></div><div className="room-list">{props.rooms.length ? props.rooms.map((item) => <button className="room-item" key={item.code} onClick={() => props.onJoinRoom(item.code)}><span className="room-item-main"><strong>{item.hostName}'s room</strong><small>CODE <b>{item.code}</b></small></span><span className="room-players"><Users size={14} />{item.players}/{item.maxPlayers}<span>&#8594;</span></span></button>) : <div className="empty-rooms"><span className="empty-doodle"><Brush size={23} /></span><strong>Nothing on the easel yet.</strong><span>Make a room and your friends can find it here.</span></div>}</div><div className="room-foot"><span>PUBLIC ROOMS ONLY</span><button onClick={props.onRandom}>Surprise me <span>&#8594;</span></button></div></aside>
    </section><footer className="home-footer"><span>SKETCHCLUB / EST. RIGHT NOW</span><span>DRAW NICE. GUESS NICER.</span></footer>
  </main>;
}

function SettingStepper(props: { label: string; value: number; min: number; max: number; step?: number; suffix: string; onChange: (value: number) => void }) {
  return <div className="setting-stepper"><span>{props.label}</span><div className="stepper-controls"><button aria-label={`Decrease ${props.label}`} disabled={props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - (props.step ?? 1)))}><Minus size={13} /></button><strong>{props.value}</strong><button aria-label={`Increase ${props.label}`} disabled={props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + (props.step ?? 1)))}><Plus size={13} /></button></div><small>{props.suffix}</small></div>;
}

function LobbyScreen(props: { room: Room; playerId: string; settings: Settings; notice: string; onReady: () => void; onStart: () => void; onSettings: (value: Settings) => void; onLeave: () => void; onCopyInvite: () => void; copied: boolean }) {
  const isHost = props.room.hostId === props.playerId;
  const self = props.room.players.find((player) => player.id === props.playerId);
  const everyoneReady = props.room.players.length >= 2 && props.room.players.every((player) => player.ready);
  return <main className="lobby-shell"><header className="topbar"><a className="brand" href="#"><span className="brand-mark"><Paintbrush size={20} /></span><span>sketchclub<span className="brand-period">.</span></span></a><button className="back-button" onClick={props.onLeave}><ArrowLeft size={16} /> Leave room</button></header>
    <section className="lobby-layout"><div className="lobby-main"><div className="lobby-title-row"><div><span className="eyebrow"><Users size={14} /> ROOM LOBBY</span><h1>Gather your <span>artists.</span></h1></div><div className="room-code-box"><span>ROOM CODE</span><strong>{props.room.code}</strong></div></div><div className="invite-strip"><div><LockKeyhole size={16} /><span>{props.room.isPrivate ? 'Private room' : 'Public room'} <b>-</b> Invite your people to join</span></div><button onClick={props.onCopyInvite}>{props.copied ? <Check size={15} /> : <Copy size={15} />}{props.copied ? 'Copied' : 'Copy invite link'}</button></div><div className="players-heading"><div><h2>Players <span>{props.room.players.length}/{props.settings.maxPlayers}</span></h2><p>{everyoneReady ? 'Looking good. Let the doodling begin.' : 'Waiting on everyone to get their game face on.'}</p></div><div className="ready-status"><i className={everyoneReady ? 'ready-all' : ''} />{props.room.players.filter((player) => player.ready).length} READY</div></div><div className="lobby-player-list">{props.room.players.map((player, index) => <div className={`lobby-player ${player.ready ? 'player-ready' : ''}`} key={player.id}><span className={`player-avatar avatar-${index % 5}`}>{player.name.slice(0, 1).toUpperCase()}</span><div className="lobby-player-name"><strong>{player.name}{player.id === props.playerId && <small>YOU</small>}</strong><span>{player.isHost ? <><Crown size={13} /> Host</> : <>{player.ready ? <Check size={13} /> : <Clock3 size={13} />}{player.ready ? 'Ready to draw' : 'Getting ready'}</>}</span></div><span className={`player-status ${player.ready ? 'status-ready' : ''}`}>{player.ready ? 'READY' : 'WAITING'}</span></div>)}{Array.from({ length: Math.max(0, Math.min(3, props.settings.maxPlayers - props.room.players.length)) }, (_, index) => <div className="lobby-player empty-player" key={`empty-${index}`}><span className="player-avatar"><Plus size={16} /></span><div className="lobby-player-name"><strong>Waiting for a friend</strong><span>Share the invite link above</span></div></div>)}</div><div className="lobby-bottom"><span>{props.room.players.length < 2 ? 'You need at least 2 players to start.' : everyoneReady ? 'Everyone is ready.' : 'Ready up when you are.'}</span>{isHost ? <button className="primary-button" disabled={!everyoneReady} onClick={props.onStart}>Start the game <span>&#8594;</span></button> : <button className={`ready-button ${self?.ready ? 'ready-button-on' : ''}`} onClick={props.onReady}>{self?.ready ? <><Check size={16} /> You're ready</> : 'Ready up'}</button>}</div>{props.notice && <div className="notice" role="status">{props.notice}</div>}</div>
      <aside className="lobby-settings"><div className="settings-heading"><div><span className="step-label">THE HOUSE RULES</span><h3>Game settings</h3></div><span className="settings-small">{isHost ? 'HOST EDITS' : 'HOST SET'}</span></div><div className="lobby-settings-list"><LobbySetting label="Players" value={props.settings.maxPlayers} min={2} max={20} suffix="players" disabled={!isHost} onChange={(value) => props.onSettings({ ...props.settings, maxPlayers: value })} /><LobbySetting label="Rounds" value={props.settings.rounds} min={2} max={10} suffix="rounds" disabled={!isHost} onChange={(value) => props.onSettings({ ...props.settings, rounds: value })} /><LobbySetting label="Draw time" value={props.settings.drawTime} min={15} max={240} step={15} suffix="sec" disabled={!isHost} onChange={(value) => props.onSettings({ ...props.settings, drawTime: value })} /><LobbySetting label="Word choices" value={props.settings.wordCount} min={1} max={5} suffix="words" disabled={!isHost} onChange={(value) => props.onSettings({ ...props.settings, wordCount: value })} /></div><div className="lobby-select"><label>Hints</label><select disabled={!isHost} value={props.settings.hints} onChange={(event) => props.onSettings({ ...props.settings, hints: Number(event.target.value) })}><option value={0}>Off</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} hints</option>)}</select><label>Word mode</label><select disabled={!isHost} value={props.settings.wordMode} onChange={(event) => props.onSettings({ ...props.settings, wordMode: event.target.value as Settings['wordMode'] })}><option value="normal">Normal</option><option value="hidden">Hidden</option><option value="combination">Combination</option></select></div><div className="lobby-tip"><Sparkles size={16} /><span>Every player gets one turn to draw each round.</span></div></aside>
    </section>
  </main>;
}

function LobbySetting(props: { label: string; value: number; min: number; max: number; step?: number; suffix: string; disabled: boolean; onChange: (value: number) => void }) {
  return <div className="lobby-setting"><span>{props.label}</span><div><button disabled={props.disabled || props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - (props.step ?? 1)))} aria-label={`Decrease ${props.label}`}><Minus size={12} /></button><strong>{props.value}</strong><button disabled={props.disabled || props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + (props.step ?? 1)))} aria-label={`Increase ${props.label}`}><Plus size={12} /></button></div><small>{props.suffix}</small></div>;
}

function GameScreen(props: { room: Room; game: GameState; name: string; isDrawer: boolean; wordOptions: string[]; messages: ChatMessage[]; notice: string; socket: Socket | null; onLeave: () => void; onCopyInvite: () => void; copied: boolean }) {
  const [color, setColor] = useState(palette[0]!);
  const [brushSize, setBrushSize] = useState(6);
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [guess, setGuess] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const guessed = props.game.guessedIds.includes(props.socket?.id ?? '');
  const currentDrawer = props.game.players.find((player) => player.id === props.game.drawerId);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [props.messages.length]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => renderCanvas(canvas, props.game.strokes);
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [props.game.strokes]);

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = guess.trim();
    if (!text) return;
    if (props.game.phase === 'drawing') props.socket?.emit('guess', { text });
    else props.socket?.emit('chat', { text });
    setGuess('');
  }

  function canvasPoint(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  return <main className="game-shell"><header className="game-header"><button className="game-brand" onClick={props.onLeave}><span className="brand-mark"><Paintbrush size={17} /></span>sketchclub<span className="brand-period">.</span></button><div className="game-round"><span>ROUND</span><strong>{Math.min(props.game.round, props.game.totalRounds)}<i>/</i>{props.game.totalRounds}</strong></div><div className="game-header-right"><span className="game-room-code">{props.room.code}</span><button className="icon-button" title="Copy invite link" onClick={props.onCopyInvite}>{props.copied ? <Check size={16} /> : <Copy size={16} />}</button><button className="leave-game" onClick={props.onLeave}><DoorOpen size={15} /> Leave</button></div></header>
    <div className="game-layout"><aside className="score-panel"><div className="panel-title"><span>THE LINEUP</span><b><Users size={14} />{props.game.players.length}</b></div><div className="score-list">{[...props.game.players].sort((a, b) => b.score - a.score).map((player, index) => <div className={`score-player ${player.id === props.game.drawerId ? 'is-drawing' : ''}`} key={player.id}><span className={`score-avatar avatar-${index % 5}`}>{player.name.slice(0, 1).toUpperCase()}</span><div><strong>{player.name}{player.id === props.socket?.id && <small>YOU</small>}</strong><span>{player.id === props.game.drawerId ? <><Brush size={11} /> Drawing</> : props.game.guessedIds.includes(player.id) ? <><Check size={11} /> Guessed it</> : player.isHost ? 'Host' : 'Playing'}</span></div><b className="score-number">{player.score}</b></div>)}</div><div className="score-note"><Trophy size={15} /><span>First correct guess scores the most.</span></div></aside>
      <section className="board-column"><div className="game-statusbar"><div className="drawer-label"><span className="turn-avatar">{(currentDrawer?.name ?? '?').slice(0, 1).toUpperCase()}</span><div><small>{props.isDrawer ? 'YOUR TURN TO DRAW' : `${currentDrawer?.name ?? 'Someone'} IS DRAWING`}</small><strong>{props.isDrawer ? 'Pick a word' : props.game.phase === 'choosing' ? 'Choosing a word...' : props.game.phase === 'roundEnd' ? 'Round complete' : 'Guess the drawing'}</strong></div></div><div className={`timer-pill ${props.game.timeLeft <= 10 ? 'timer-low' : ''}`}><Clock3 size={16} /><strong>{formatTime(props.game.timeLeft)}</strong></div><div className="word-hint"><span>{props.isDrawer ? 'YOUR WORD' : 'THE WORD'}</span><strong>{props.isDrawer ? (props.game.word ?? '...') : (props.game.wordHint || '_ _ _ _ _')}</strong></div></div>
        <div className="canvas-frame"><div className="canvas-topline"><span><i /> LIVE CANVAS</span><span>{props.game.phase === 'drawing' ? 'EVERY STROKE COUNTS' : props.game.phase === 'choosing' ? 'WORD PICK IN PROGRESS' : 'ROUND BREAK'}</span></div><canvas ref={canvasRef} className={`drawing-canvas ${props.isDrawer && props.game.phase === 'drawing' ? 'canvas-enabled' : ''}`} aria-label="Shared drawing canvas" onPointerDown={(event) => { if (!props.isDrawer || props.game.phase !== 'drawing') return; event.currentTarget.setPointerCapture(event.pointerId); props.socket?.emit('draw_start', { point: canvasPoint(event), color, size: brushSize, tool }); }} onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !props.isDrawer) return; props.socket?.emit('draw_move', { point: canvasPoint(event) }); }} onPointerUp={() => props.socket?.emit('draw_end')} onPointerCancel={() => props.socket?.emit('draw_end')} />
          {props.game.phase === 'choosing' && <div className="canvas-overlay"><div className="word-picker"><span className="step-label">MAKE IT A GOOD ONE</span><h3>{props.isDrawer ? 'Choose your word' : 'The drawer is choosing...'}</h3>{props.isDrawer ? <div className="word-options">{props.wordOptions.map((word) => <button key={word} onClick={() => props.socket?.emit('choose_word', { word })}>{word}<span>&#8599;</span></button>)}</div> : <div className="choosing-dots"><i /><i /><i /></div>}</div></div>}
          {props.game.phase === 'roundEnd' && <div className="canvas-overlay"><div className="round-reveal"><span className="reveal-icon"><Check size={19} /></span><span className="step-label">THE WORD WAS</span><h3>{props.game.word ?? (props.game.wordHint.replaceAll('_', '').trim() || 'Nice drawing!')}</h3><p>Next turn starts in a moment</p></div></div>}
          {props.game.phase === 'gameOver' && <div className="canvas-overlay"><div className="round-reveal"><span className="reveal-icon"><Trophy size={19} /></span><span className="step-label">GAME OVER</span><h3>{props.game.players.slice().sort((a, b) => b.score - a.score)[0]?.name ?? 'Well played!'}</h3><p>takes the crown</p><button className="primary-button" onClick={props.onLeave}>Back to rooms</button></div></div>}
          {props.game.phase === 'drawing' && props.isDrawer && <div className="canvas-tools"><div className="tool-group"><button className={tool === 'brush' ? 'active-tool' : ''} title="Brush" onClick={() => setTool('brush')}><Brush size={16} /></button><button className={tool === 'eraser' ? 'active-tool' : ''} title="Eraser" onClick={() => setTool('eraser')}><Eraser size={16} /></button><button title="Undo last stroke" onClick={() => props.socket?.emit('draw_undo')}><RotateCcw size={15} /></button><button title="Clear canvas" onClick={() => props.socket?.emit('canvas_clear')}><Minus size={16} /></button></div><div className="color-swatches">{palette.map((value) => <button key={value} title={`Color ${value}`} aria-label={`Select color ${value}`} className={color === value ? 'selected-swatch' : ''} style={{ backgroundColor: value }} onClick={() => setColor(value)} />)}</div><label className="brush-size-control" title="Brush size"><input type="range" min="2" max="24" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><span>{brushSize}</span></label></div>}
        </div><div className="board-footer"><span><Eye size={14} /> {props.game.guessedIds.length} guessed</span><span>{props.isDrawer ? 'Everyone can see your strokes live.' : 'Your guess is your secret weapon.'}</span></div></section>
      <aside className="chat-panel"><div className="chat-heading"><div><span className="step-label">THE CHATTER</span><h2><MessageCircle size={17} /> Room chat</h2></div><span className="chat-live">LIVE</span></div><div className="chat-messages">{props.messages.length === 0 && <div className="chat-empty"><MessageCircle size={20} /><span>Say hello while the canvas is blank.</span></div>}{props.messages.map((message, index) => <div className={`chat-message ${message.isGuess ? 'guess-message' : ''}`} key={`${message.timestamp}-${index}`}><strong>{message.playerName}</strong><span>{message.close ? 'is very close...' : message.text}</span></div>)}<div ref={chatEndRef} /></div><form className="chat-form" onSubmit={sendMessage}><input aria-label={props.game.phase === 'drawing' ? 'Guess the word' : 'Send a chat message'} value={guess} onChange={(event) => setGuess(event.target.value)} placeholder={props.game.phase === 'drawing' ? (guessed ? 'You guessed it!' : 'Type your guess...') : 'Say something...'} disabled={props.game.phase === 'gameOver' || (props.game.phase === 'drawing' && (props.isDrawer || guessed))} maxLength={100} /><button aria-label="Send message" disabled={!guess.trim()}><Send size={16} /></button></form>{props.notice && <div className="game-notice" role="status">{props.notice}</div>}</aside>
    </div><footer className="game-footer"><span><span className="footer-online" /> YOU'RE IN A LIVE ROOM</span><span>NO ART DEGREE REQUIRED</span></footer>
  </main>;
}

function renderCanvas(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.beginPath();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = stroke.size;
    context.strokeStyle = stroke.tool === 'eraser' ? '#fffefa' : stroke.color;
    context.moveTo(stroke.points[0]!.x * rect.width, stroke.points[0]!.y * rect.height);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * rect.width, point.y * rect.height);
    if (stroke.points.length === 1) context.lineTo(stroke.points[0]!.x * rect.width + 0.01, stroke.points[0]!.y * rect.height + 0.01);
    context.stroke();
  }
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

