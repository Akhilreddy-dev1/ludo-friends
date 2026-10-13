# Ludo Friends

Ludo Friends is a TypeScript pnpm monorepo for a server-authoritative multiplayer Ludo-style game. The first milestone supports 2–4 players, four colors, lobby readiness, reconnect-safe disconnect handling, timed turns, and a responsive browser board.

## Setup

Requirements: Node 20+ and pnpm 9+.

```bash
pnpm install
copy .env.example .env
pnpm dev
```

The web app runs at `http://localhost:5173` and the Socket.IO server at `http://localhost:3001`. Useful scripts are `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check`.

## Architecture

- `packages/game-core`: pure, deterministic rules and state transitions. It has no networking or browser dependencies.
- `packages/shared`: typed Socket.IO event contracts and the room snapshot shape.
- `apps/server`: Express health endpoint, Socket.IO transport, room lifecycle, turn timer, and authoritative validation.
- `apps/web`: React/Vite lobby and interactive board. The client renders snapshots and never mutates game state optimistically.

## Rules and assumptions

Positions are `0` (yard), `1..52` (public track), and `53..56` (color home lane / center); `56` is the exact finished position. A token enters only on a six. A six normally grants another roll, but a third consecutive six forfeits that turn. Captures grant another roll unless the move finishes the game. Safe cells are the eight star/entry cells `[1, 9, 14, 22, 27, 35, 40, 48]`; opponents cannot be captured there. A player wins when all four tokens reach position 56. The server clamps the configured turn timer to 15–30 seconds and advances a timed-out turn.

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

## Event contract

Clients emit `createRoom({name, turnSeconds?})`, `joinRoom({code, name})`, `selectColor({color})`, `setReady({ready})`, `rollDice()`, `moveToken({tokenId})`, and `leaveRoom()`. Every event uses a typed acknowledgement `{ok:true,data}` or `{ok:false,error:{code,message}}`. The server broadcasts `snapshot(RoomSnapshot)` after every accepted action and emits typed `error` messages for transport-level errors.
