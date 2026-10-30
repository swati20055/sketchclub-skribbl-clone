# Sketchclub

A real-time drawing and guessing party game built for the Skribbl.io clone assignment. The app uses a React + TypeScript client, an Express server, HTML Canvas, and Socket.IO for multiplayer state.

## Run locally

Requirements: Node.js 20 or newer and npm.

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. `npm run dev` starts the Vite client on port 5173 and the Socket.IO server on port 3001. Open a second browser window or device to join the same room and play the full flow.

For a production build and local server:

```powershell
npm run build
npm start
```

Then open <http://localhost:3001>. The server serves the built client and exposes `GET /health` for hosting health checks. `PORT` is configurable; see `.env.example`.

Run the two-client Socket.IO smoke test while the server is running:

```powershell
npm run test:smoke
```

## Gameplay

- Create a public or private room, configure players (2-20), rounds (2-10), draw time (15-240 seconds), word choices (1-5), hints (0-5), and word mode.
- Join using a five-character room code, a copied invite link, an open-room listing, or the random-room button.
- Players ready up in the lobby; the host starts once at least two players are present and everyone is ready.
- Each player draws once per configured round. The drawer chooses from the configured number of words. A 20-second fallback selects a word if the drawer does not pick one.
- Guesses are trimmed, case-insensitive, and whitespace-normalized. Correct guesses earn points once per player per turn; the first correct guess earns the most. The drawer also earns points for correct guesses.
- Hints reveal letters over time. In hidden mode, the word stays masked. Combination mode mixes single and paired word choices.
- The drawing toolbar includes brush, color, size, eraser, undo, and clear. Only the drawer can change the canvas.

## Architecture

```text
React UI (src/App.tsx)
  | Socket.IO client events
  v
Express + Socket.IO (server/index.ts)
  | Room owns membership/settings; Game owns phase/turn/scoring/timers
  v
Room-scoped broadcasts and per-player game_state
```

`server/game.ts` contains the `Player`, `Room`, and `Game` classes. The server is authoritative: it validates room membership, host actions, drawer-only drawing, selected words, and guesses before changing state. Each drawing point is normalized to the 0-1 canvas range, so all clients can render the same stroke at their own canvas size. `draw_start`, `draw_move`, and `draw_end` carry stroke updates over Socket.IO; `canvas_clear` and `draw_undo` synchronize edits. The client redraws retained stroke data on resize and when new stroke data arrives.

Private word data is sent only to the drawer in `game_state`; other players receive a masked hint. The server broadcasts scores, round transitions, chat, and end-of-game leaderboard updates to the room. Guess matching uses trimmed, lowercased, whitespace-normalized exact comparison. Prefix feedback is private to the guesser.

### Main Socket.IO events

| Event | Direction | Purpose |
| --- | --- | --- |
| `create_room`, `join_room`, `join_random` | Client to server | Create/join a public or private lobby |
| `player_joined`, `player_left`, `room_updated` | Server to clients | Keep lobby membership and host/settings current |
| `ready_toggle`, `update_settings`, `start_game` | Client to server | Lobby readiness and host-controlled game setup |
| `round_start`, `word_options`, `choose_word` | Both | Start a drawer's turn and privately choose the answer |
| `game_state`, `word_chosen`, `round_end`, `game_over` | Server to clients | Synchronize phase, timers, scores, winner |
| `draw_start`, `draw_move`, `draw_end`, `draw_data` | Both | Stream normalized canvas strokes |
| `canvas_clear`, `draw_undo` | Both | Synchronize canvas edits |
| `guess`, `guess_result`, `chat`, `chat_message`, `hint_revealed` | Both | Guessing, chat, feedback, and hints |

## Deploy on Render

The included `render.yaml` defines a single Node web service. From the Render dashboard, create a new Blueprint instance from this repository and deploy it. Render installs dependencies, runs `npm run build`, starts `npm start`, and checks `/health`. The client and WebSocket API share one origin, so no separate frontend URL or CORS setting is required.

After deployment, add the public URL below and test room creation, joining from a second browser, drawing, guessing, scoring, and reconnect behavior on the hosted service:

**Live URL:** _Not deployed yet. A Render account and a Git repository connected to Render are required to publish this workspace._

## Assignment coverage

Implemented: configurable rooms and links/codes; lobby and readiness; turn-based drawing; synchronized canvas; word selection; guessing, hints, chat, countdown, scoring, leaderboard, game winner; brush/colors/size/undo/clear/eraser; normal/hidden/combination word modes; public room discovery; responsive UI; setup and architecture documentation.

Optional bonus items not implemented: custom host word lists, avatars, spectators, replay, kick/ban, votekick, and multiple-language word lists.
