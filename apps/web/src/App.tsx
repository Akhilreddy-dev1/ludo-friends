import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { COLORS, publicCell, type Color, type Player } from "@ludo/game-core";
import type {
  ClientToServerEvents,
  RoomSnapshot,
  ServerToClientEvents,
} from "@ludo/shared";

const SERVER = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function App() {
  const [socket] = useState<AppSocket>(() =>
    io(SERVER, { autoConnect: false }),
  );
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const me = snapshot?.state.players.find((player) => player.id === socket.id);

  useEffect(() => {
    socket.connect();
    socket.on("snapshot", setSnapshot);
    socket.on("error", (event) => setError(event.message));
    return () => {
      socket.off("snapshot", setSnapshot);
      socket.disconnect();
    };
  }, [socket]);
  useEffect(() => {
    if (!snapshot?.state.turnDeadline) return;
    const update = () =>
      setSeconds(
        Math.max(
          0,
          Math.ceil((snapshot.state.turnDeadline! - Date.now()) / 1000),
        ),
      );
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.state.turnDeadline]);

  const create = () =>
    socket.emit("createRoom", { name, turnSeconds: 20 }, (result) => {
      if (!result.ok) setError(result.error.message);
      else setError("");
    });
  const join = () =>
    socket.emit("joinRoom", { code, name }, (result) => {
      if (!result.ok) setError(result.error.message);
      else setError("");
    });

  if (!snapshot)
    return (
      <main className="shell">
        <section className="hero">
          <p className="eyebrow">LUDO FRIENDS</p>
          <h1>
            Roll. Race. <span>Reunite.</span>
          </h1>
          <p className="lede">
            A fast, friendly multiplayer board game for your next group chat.
          </p>
        </section>
        <section className="card entry">
          <label>
            Your name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Maya"
            />
          </label>
          <button disabled={!name.trim()} onClick={create}>
            Create a room
          </button>
          <div className="or">or join with an invite code</div>
          <div className="join-row">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
            />
            <button disabled={!name.trim() || code.length !== 6} onClick={join}>
              Join
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  if (snapshot.state.phase === "lobby")
    return <Lobby snapshot={snapshot} me={me} socket={socket} error={error} />;
  return (
    <Game
      snapshot={snapshot}
      me={me}
      socket={socket}
      seconds={seconds}
      error={error}
    />
  );
}

function Lobby({
  snapshot,
  me,
  socket,
  error,
}: {
  snapshot: RoomSnapshot;
  me?: Player;
  socket: AppSocket;
  error: string;
}) {
  const choose = (color: Color) =>
    socket.emit("selectColor", { color }, (result) => {
      if (!result.ok) alert(result.error.message);
    });
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ROOM CODE</p>
          <strong className="room-code">{snapshot.code}</strong>
        </div>
        <button
          className="ghost"
          onClick={() => navigator.clipboard?.writeText(snapshot.code)}
        >
          Copy invite
        </button>
      </header>
      <section className="card lobby">
        <p className="eyebrow">LOBBY</p>
        <h2>Choose your color</h2>
        <p className="muted">
          Share the code with friends. Everyone must be ready before the race
          begins.
        </p>
        <div className="players">
          {snapshot.state.players.map((player) => (
            <div className="player" key={player.id}>
              <span className={`dot ${player.color}`} />
              <div>
                <strong>
                  {player.name}
                  {player.id === me?.id ? " (you)" : ""}
                </strong>
                <small>
                  {player.ready ? "Ready to race" : "Choosing a color"}
                </small>
              </div>
              <span className="status">{player.ready ? "✓" : "…"}</span>
            </div>
          ))}
        </div>
        <div className="color-picker">
          {COLORS.map((color) => (
            <button
              key={color}
              className={`color-choice ${color} ${me?.color === color ? "selected" : ""}`}
              disabled={snapshot.state.players.some(
                (player) => player.color === color && player.id !== me?.id,
              )}
              onClick={() => choose(color)}
            >
              {color}
            </button>
          ))}
        </div>
        <button
          className="ready"
          onClick={() =>
            socket.emit("setReady", { ready: !me?.ready }, () => undefined)
          }
        >
          {me?.ready ? "I'm ready ✓" : "Ready up"}
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

const path = Array.from({ length: 52 }, (_, index) => index + 1);
function Game({
  snapshot,
  me,
  socket,
  seconds,
  error,
}: {
  snapshot: RoomSnapshot;
  me?: Player;
  socket: AppSocket;
  seconds: number;
  error: string;
}) {
  const current = snapshot.state.currentPlayerId === me?.id;
  const legal = useMemo(() => {
    const roll = snapshot.state.dice;
    return me && roll
      ? me.tokens
          .filter((token) =>
            token.position === 0 ? roll === 6 : token.position + roll <= 56,
          )
          .map((token) => token.id)
      : [];
  }, [me, snapshot.state.dice]);
  return (
    <main className="shell game-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ROOM {snapshot.code}</p>
          <h2>
            {current
              ? "Your turn"
              : `${snapshot.state.players.find((player) => player.id === snapshot.state.currentPlayerId)?.name ?? "Player"}'s turn`}
          </h2>
        </div>
        <div className="timer">{seconds}s</div>
      </header>
      <section className="game-layout">
        <div className="board-wrap">
          <Board
            snapshot={snapshot}
            legal={legal}
            onMove={(tokenId) =>
              socket.emit("moveToken", { tokenId }, () => undefined)
            }
          />
        </div>
        <aside className="card controls">
          <div className="dice">{snapshot.state.dice ?? "?"}</div>
          <button
            className="roll"
            disabled={!current || snapshot.state.dice !== null}
            onClick={() => socket.emit("rollDice", () => undefined)}
          >
            Roll dice
          </button>
          <p className="muted">
            {snapshot.state.dice
              ? "Pick a highlighted token."
              : current
                ? "Roll to begin your turn."
                : "Watch the board — your turn is next."}
          </p>
          <div className="scoreboard">
            {snapshot.state.players.map((player) => (
              <div className="score" key={player.id}>
                <span className={`dot ${player.color}`} />
                <span>{player.name}</span>
                <span>
                  {
                    player.tokens.filter((token) => token.position === 56)
                      .length
                  }
                  /4
                </span>
              </div>
            ))}
          </div>
          {snapshot.state.winnerId && (
            <div className="winner">
              🏆{" "}
              {
                snapshot.state.players.find(
                  (player) => player.id === snapshot.state.winnerId,
                )?.name
              }{" "}
              wins!
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </aside>
      </section>
    </main>
  );
}

function Board({
  snapshot,
  legal,
  onMove,
}: {
  snapshot: RoomSnapshot;
  legal: number[];
  onMove: (tokenId: number) => void;
}) {
  const cells = new Map<number, { player: Player; tokenId: number }[]>();
  snapshot.state.players.forEach((player) =>
    player.tokens.forEach((token) => {
      const cell = publicCell(player.color, token.position);
      if (cell)
        cells.set(cell, [
          ...(cells.get(cell) ?? []),
          { player, tokenId: token.id },
        ]);
    }),
  );
  return (
    <div className="board">
      <div className="home red-home">RED</div>
      <div className="home green-home">GREEN</div>
      <div className="home yellow-home">YELLOW</div>
      <div className="home blue-home">BLUE</div>
      <div className="center">✦</div>
      {path.map((cell) => (
        <div className={`track-cell cell-${cell}`} key={cell}>
          {(cells.get(cell) ?? []).map(({ player, tokenId }) => (
            <button
              className={`token ${player.color} ${player.id === snapshot.state.currentPlayerId && legal.includes(tokenId) ? "legal" : ""}`}
              key={`${player.id}-${tokenId}`}
              onClick={() => onMove(tokenId)}
              aria-label={`${player.name} token ${tokenId + 1}`}
            >
              {tokenId + 1}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
export default App;
