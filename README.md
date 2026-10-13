# Ludo Friends

Ludo Friends is a server-authoritative, browser-based multiplayer Ludo-style game for groups of 2–4 friends. Players create or join a room, choose a color, ready up, and race four tokens around the board. The server owns the game state and validates every roll and move, while the web client renders the latest snapshot.

## Prerequisites

- Node.js 20 or newer
- Corepack, included with supported Node.js distributions
- A modern browser

Enable the repository's pinned pnpm version once on your machine:

```bash
corepack enable
corepack pnpm --version
```

## Project structure

```text
apps/
  server/       Express + Socket.IO authoritative game server
  web/          React + Vite browser client
packages/
  game-core/    Pure rules, state models, and focused unit tests
  shared/       Typed Socket.IO event and snapshot contracts
```

### Architecture

- **`packages/game-core`** contains deterministic rules and state transitions with no browser or networking dependencies. This keeps game behavior testable and reusable.
- **`packages/shared`** defines the TypeScript contracts shared by the server and client.
- **`apps/server`** exposes an Express health endpoint and Socket.IO transport. It manages rooms, readiness, disconnects, turn deadlines, dice rolls, legal moves, captures, and wins.
- **`apps/web`** provides the lobby and responsive board. It listens for server snapshots and does not optimistically mutate game state.

## Install and run

Install workspace dependencies:

```bash
corepack pnpm install
```

Start the server and web client together:

```bash
corepack pnpm dev
```

The default development URLs are:

- Web client: `http://localhost:5173`
- Server health check: `http://localhost:3001/health`

## Commands

Run commands from the repository root:

| Command                      | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `corepack pnpm dev`          | Start the server and web development processes   |
| `corepack pnpm test`         | Run all package tests                            |
| `corepack pnpm typecheck`    | Type-check every workspace                       |
| `corepack pnpm build`        | Build all packages and the production web bundle |
| `corepack pnpm format`       | Format supported source and documentation files  |
| `corepack pnpm format:check` | Verify formatting without changing files         |

## Environment variables

Copy `.env.example` to `.env` using the conventions of your shell, then adjust values as needed. `.env` is ignored by Git and should not contain secrets that are safe to share.

| Variable          | Used by | Default                 | Description                                       |
| ----------------- | ------- | ----------------------- | ------------------------------------------------- |
| `PORT`            | Server  | `3001`                  | HTTP and Socket.IO port                           |
| `TURN_SECONDS`    | Server  | `20`                    | Turn timer; the server clamps it to 15–30 seconds |
| `VITE_SERVER_URL` | Web     | `http://localhost:3001` | Socket.IO server URL used by the browser          |

Example values:

```dotenv
PORT=3001
TURN_SECONDS=20
VITE_SERVER_URL=http://localhost:3001
```

## Development workflow

1. Enable Corepack and install dependencies with the pinned pnpm version.
2. Start `corepack pnpm dev`.
3. Open the web URL in two to four browser windows or profiles.
4. Create a room in one window and share its six-character code with the others.
5. Select colors, ready all players, and play through the server-authoritative board.
6. Before submitting changes, run `corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm format:check`.

The server is the source of truth. A client should treat `snapshot` events as the complete current state and should surface acknowledgement errors rather than inventing local success.

## Rules and assumptions

- There are four colors: red, green, yellow, and blue.
- Rooms support 2–4 players. Each player has four tokens.
- A token position is `0` for the yard, `1..52` for the public track, and `53..56` for the color home lane and center. Position `56` is the exact finished position.
- A token can leave the yard only on a six.
- A six grants another roll, except that a third consecutive six forfeits the turn.
- A capture on a non-safe opponent cell grants another roll.
- Safe cells protect tokens from capture. The current safe-cell set is `[1, 9, 14, 22, 27, 35, 40, 48]`.
- A move cannot pass the final position; exact progress to `56` is required.
- The first player to bring all four tokens to `56` wins.
- The server advances a turn when its 15–30 second deadline expires.
- Disconnecting marks a player disconnected and broadcasts the updated snapshot. A room is removed after all of its players have disconnected.

## Testing

The rules package has focused tests for yard entry, track mapping, and captures. The server package tests room readiness and extra-turn behavior. Run the complete suite with:

```bash
corepack pnpm test
```

For a quick confidence check before a commit:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm format:check
```

## Production build

Create production artifacts with:

```bash
corepack pnpm build
```

The web bundle is emitted under `apps/web/dist`, and the compiled server/package output is emitted under each workspace's `dist` directory. Set `PORT`, `TURN_SECONDS`, and `VITE_SERVER_URL` appropriately for the deployment environment. The current milestone does not include a production static-file host or process manager; deploy the web bundle and Node server using the platform's standard services.

## Socket.IO events

All client events use typed acknowledgement callbacks:

```ts
{ ok: true, data: T }
{ ok: false, error: { code: string, message: string } }
```

### Client to server

| Event         | Payload                  | Purpose                                                     |
| ------------- | ------------------------ | ----------------------------------------------------------- |
| `createRoom`  | `{ name, turnSeconds? }` | Create a room and receive its six-character invite code     |
| `joinRoom`    | `{ code, name }`         | Join an existing room with an available color               |
| `selectColor` | `{ color }`              | Change color while the room is in the lobby                 |
| `setReady`    | `{ ready }`              | Set or clear the current player's ready state               |
| `rollDice`    | none                     | Roll for the current player when no roll is awaiting a move |
| `moveToken`   | `{ tokenId }`            | Move one legal token using the server-held dice result      |
| `leaveRoom`   | none                     | Leave the room explicitly                                   |

### Server to client

| Event      | Payload             | Purpose                                                            |
| ---------- | ------------------- | ------------------------------------------------------------------ |
| `snapshot` | `RoomSnapshot`      | Complete room and game state after accepted actions or disconnects |
| `error`    | `{ code, message }` | Transport-level error notification                                 |

The snapshot includes the room code, host ID, configured turn duration, phase, players, token positions, current player, dice result, consecutive-six count, turn deadline, and winner.

## Snapshot example

```json
{
  "code": "ABC123",
  "hostId": "socket-id",
  "turnSeconds": 20,
  "state": {
    "phase": "playing",
    "currentPlayerId": "socket-id",
    "dice": 6,
    "consecutiveSixes": 1,
    "turnDeadline": 1730000000000,
    "winnerId": null,
    "players": [
      {
        "id": "socket-id",
        "name": "Maya",
        "color": "red",
        "ready": true,
        "connected": true,
        "tokens": [
          { "id": 0, "position": 0 },
          { "id": 1, "position": 12 },
          { "id": 2, "position": 56 },
          { "id": 3, "position": 0 }
        ]
      }
    ]
  }
}
```

## Troubleshooting

### `pnpm` is not recognized

Use the pinned command form, `corepack pnpm ...`, and run `corepack enable` if Corepack is not active.

### The browser cannot connect to the server

Confirm that the server process is running, visit `http://localhost:3001/health`, and check that `VITE_SERVER_URL` matches the server address. Restart the Vite process after changing Vite environment variables.

### A room will not start

At least two connected players must be in the room, each player must have a distinct color, and every connected player must be ready.

### A move is rejected

The server may have advanced the turn, the dice may not have been rolled, the token may not be legal for that roll, or the move may exceed position `56`. Refreshing is normally unnecessary because the next `snapshot` contains the authoritative state.

### The turn timer behaves unexpectedly

`TURN_SECONDS` is intentionally limited to 15–30 seconds. Restart the server after changing it, and check the server clock if deadlines appear out of sync.
