import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  COLORS,
  SAFE_CELLS,
  publicCell,
  legalTokenIds,
  moveToken as coreMove,
  createGameState,
  createPlayer,
  type Color,
  type Player,
  type GameState,
  type Token,
} from "@ludo/game-core";
import type {
  ClientToServerEvents,
  RoomSnapshot,
  ServerToClientEvents,
} from "@ludo/shared";

const SERVER_CONFIGURED = Boolean(import.meta.env.VITE_SERVER_URL) || import.meta.env.DEV;
const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Mode = "menu" | "bot" | "multiplayer";

// ─── Bot AI ──────────────────────────────────────────────────────────────────
function scoreBotMove(
  state: GameState,
  botId: string,
  tokenId: number,
  roll: number
): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const token = bot.tokens.find((t) => t.id === tokenId)!;
  let score = 0;
  const newPos = token.position === 0 ? 1 : token.position + roll;
  // Finish token → highest priority
  if (newPos === 56) score += 200;
  // Leave yard
  if (token.position === 0) score += 50;
  // Check capture
  const cell = publicCell(bot.color, newPos as never);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    for (const opp of state.players) {
      if (opp.id === botId) continue;
      for (const ot of opp.tokens) {
        if (publicCell(opp.color, ot.position) === cell) score += 100;
      }
    }
  }
  // Progress bonus
  score += newPos;
  return score;
}

function pickBotToken(state: GameState, botId: string, roll: number): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const legal = legalTokenIds(bot, roll);
  if (legal.length === 0) return -1;
  return legal.reduce((best, id) =>
    scoreBotMove(state, botId, id, roll) > scoreBotMove(state, botId, best, roll)
      ? id
      : best
  );
}

// ─── Bot game state ───────────────────────────────────────────────────────────
interface BotState {
  gameState: GameState;
  phase: "playing" | "finished";
}

type BotAction =
  | { type: "ROLL"; result: number }
  | { type: "MOVE"; playerId: string; tokenId: number }
  | { type: "ADVANCE" };

const HUMAN_ID = "human";
const BOT_IDS = ["bot-1", "bot-2", "bot-3"];
const BOT_COLORS: Color[] = ["green", "yellow", "blue"];

function makeBotInitialState(): BotState {
  const gs = createGameState();
  gs.players.push(createPlayer(HUMAN_ID, "You", "red"));
  BOT_IDS.forEach((id, i) =>
    gs.players.push(createPlayer(id, `Bot ${i + 1}`, BOT_COLORS[i]))
  );
  gs.phase = "playing";
  gs.currentPlayerId = HUMAN_ID;
  return { gameState: gs, phase: "playing" };
}

function botReducer(state: BotState, action: BotAction): BotState {
  if (state.phase === "finished") return state;
  const gs = structuredClone(state.gameState) as GameState;

  switch (action.type) {
    case "ROLL": {
      if (gs.dice !== null) return state;
      gs.dice = action.result;
      gs.consecutiveSixes =
        action.result === 6 ? gs.consecutiveSixes + 1 : 0;
      if (gs.consecutiveSixes >= 3) {
        gs.dice = null;
        gs.consecutiveSixes = 0;
        // advance
        const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
        gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      } else {
        // check if any legal move exists
        const cur = gs.players.find((p) => p.id === gs.currentPlayerId)!;
        const legal = legalTokenIds(cur, action.result);
        if (legal.length === 0) {
          // If it's human, we keep dice visible briefly so they understand why turn passed
          gs.dice = action.result;
        }
      }
      return { ...state, gameState: gs };
    }
    case "MOVE": {
      if (gs.dice === null) return state;
      const roll = gs.dice;
      const result = coreMove(gs, action.playerId, action.tokenId, roll);
      if (!result.moved) return state;
      gs.dice = null;
      if (result.winner) return { gameState: gs, phase: "finished" };
      if (roll === 6 || result.captured) return { ...state, gameState: gs };
      // advance turn
      const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
      gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      gs.consecutiveSixes = 0;
      return { ...state, gameState: gs };
    }
    case "ADVANCE": {
      gs.dice = null;
      const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
      gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      gs.consecutiveSixes = 0;
      return { ...state, gameState: gs };
    }
    default:
      return state;
  }
}

// ─── Dice component ──────────────────────────────────────────────────────────
const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
function Dice3D({
  value,
  rolling,
  onClick,
  disabled,
}: {
  value: number | null;
  rolling: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const [display, setDisplay] = useState(value ?? 1);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (rolling) {
      intervalRef.current = window.setInterval(() => {
        setDisplay(Math.floor(Math.random() * 6) + 1);
      }, 80);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (value !== null) setDisplay(value);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [rolling, value]);

  return (
    <button
      className={`dice-3d${rolling ? " rolling" : ""}${disabled ? " disabled" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Not your turn" : "Roll the dice!"}
    >
      <span className="dice-face">{DICE_FACES[display - 1]}</span>
    </button>
  );
}

// ─── Board component ─────────────────────────────────────────────────────────
const TRACK_COORDS: readonly [number, number][] = [[1,6],[2,6],[3,6],[4,6],[5,6],[6,5],[6,4],[6,3],[6,2],[6,1],[6,0],[7,0],[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[9,6],[10,6],[11,6],[12,6],[13,6],[14,6],[14,7],[14,8],[13,8],[12,8],[11,8],[10,8],[9,8],[8,9],[8,10],[8,11],[8,12],[8,13],[8,14],[7,14],[6,14],[6,13],[6,12],[6,11],[6,10],[6,9],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],[0,7],[0,6]];
const TRACK_PATH = Array.from({ length: 52 }, (_, i) => i + 1);
const HOME_LANE_COORDS: Record<Color, readonly [number, number][]> = {
  red: [[3, 7], [4, 7], [5, 7]], green: [[7, 3], [7, 4], [7, 5]],
  yellow: [[11, 7], [10, 7], [9, 7]], blue: [[7, 11], [7, 10], [7, 9]],
};

function Board({
  players,
  currentPlayerId,
  dice,
  legalIds,
  onMove,
}: {
  players: Player[];
  currentPlayerId: string | null;
  dice: number | null;
  legalIds: number[];
  onMove: (tokenId: number) => void;
}) {
  const cells = useMemo(() => {
    const map = new Map<number, { player: Player; token: Token }[]>();
    players.forEach((player) =>
      player.tokens.forEach((token) => {
        const cell = publicCell(player.color, token.position);
        if (cell !== null)
          map.set(cell, [
            ...(map.get(cell) ?? []),
            { player, token },
          ]);
      })
    );
    return map;
  }, [players]);

  // Yard tokens (position 0)
  const yardTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const yard = p.tokens.filter((t) => t.position === 0);
      if (yard.length) map.set(p.id, yard);
    });
    return map;
  }, [players]);

  // Home stretch tokens (positions 53, 54, 55)
  const laneTokens = useMemo(() => {
    const map = new Map<string, { player: Player; token: Token }[]>();
    players.forEach((p) => {
      p.tokens.forEach((token) => {
        if (token.position >= 53 && token.position <= 55) {
          const key = `${p.color}-${token.position}`;
          map.set(key, [...(map.get(key) ?? []), { player: p, token }]);
        }
      });
    });
    return map;
  }, [players]);

  // Home tokens (position 56)
  const homeTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const home = p.tokens.filter((t) => t.position === 56);
      if (home.length) map.set(p.id, home);
    });
    return map;
  }, [players]);

  const getPlayerByColor = (color: Color) =>
    players.find((p) => p.color === color);

  return (
    <div className="board-perspective">
      <div className="board-3d">
        {/* Corner home zones */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const player = getPlayerByColor(color);
          const yardToks = player ? yardTokens.get(player.id) ?? [] : [];
          return (
            <div key={color} className={`home-zone ${color}-zone`}>
              <div className="home-label">{color.toUpperCase()}</div>
              <div className="yard-grid">
                {[0, 1, 2, 3].map((slot) => {
                  const tok = yardToks[slot];
                  const isLegal =
                    tok &&
                    player?.id === currentPlayerId &&
                    legalIds.includes(tok.id);
                  return (
                    <div key={slot} className="yard-slot">
                      {tok ? (
                        <button
                          className={`token-3d ${color}${isLegal ? " legal" : ""}`}
                          onClick={() => isLegal && onMove(tok.id)}
                          title={isLegal ? "Move this token!" : undefined}
                        >
                          {tok.id + 1}
                        </button>
                      ) : (
                        <div className="yard-dot" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Center finish */}
        <div className="board-center">
          <span className="center-star">★</span>
          <div className="home-tokens-center">
            {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
              const player = getPlayerByColor(color);
              const hToks = player ? homeTokens.get(player.id) ?? [] : [];
              return hToks.map((tok) => (
                <div key={`${color}-${tok.id}`} className={`token-3d ${color} finished`}>
                  ✓
                </div>
              ));
            })}
          </div>
        </div>

        {/* Home runway cells (positions 53-55) */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          return [53, 54, 55].map((pos) => {
            const list = laneTokens.get(`${color}-${pos}`) ?? [];
            return (
              <div
                key={`${color}-${pos}`}
                className="track-cell safe-cell" style={{ left: `${HOME_LANE_COORDS[color][pos - 53][0] * 100 / 15}%`, top: `${HOME_LANE_COORDS[color][pos - 53][1] * 100 / 15}%` }}
              >
                {list.map(({ player, token }) => {
                  const isLegal =
                    player.id === currentPlayerId && legalIds.includes(token.id);
                  return (
                    <button
                      key={`${player.id}-${token.id}`}
                      className={`token-3d ${player.color}${isLegal ? " legal" : ""}`}
                      onClick={() => isLegal && onMove(token.id)}
                      aria-label={`${player.name} token ${token.id + 1}`}
                      title={isLegal ? "Move this token!" : undefined}
                    >
                      {token.id + 1}
                    </button>
                  );
                })}
              </div>
            );
          });
        })}

        {/* Track cells */}
        {TRACK_PATH.map((cell) => {
          const tokensOnCell = cells.get(cell) ?? [];
          const isSafe = SAFE_CELLS.has(cell);
          return (
            <div
              key={cell}
              className={`track-cell${isSafe ? " safe-cell" : ""}`} style={{ left: `${TRACK_COORDS[cell - 1][0] * 100 / 15}%`, top: `${TRACK_COORDS[cell - 1][1] * 100 / 15}%` }}
            >
              {isSafe && <span className="safe-star">⭐</span>}
              {tokensOnCell.map(({ player, token }) => {
                const isLegal =
                  player.id === currentPlayerId && legalIds.includes(token.id);
                return (
                  <button
                    key={`${player.id}-${token.id}`}
                    className={`token-3d ${player.color}${isLegal ? " legal" : ""}`}
                    onClick={() => isLegal && onMove(token.id)}
                    aria-label={`${player.name} token ${token.id + 1}`}
                    title={isLegal ? "Move this token!" : undefined}
                  >
                    {token.id + 1}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Bot Game ────────────────────────────────────────────────────────────────
function BotGame({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(botReducer, null, makeBotInitialState);
  const [rolling, setRolling] = useState(false);
  const { gameState: gs, phase } = state;
  const isMyTurn = gs.currentPlayerId === HUMAN_ID;
  const isBot = BOT_IDS.includes(gs.currentPlayerId ?? "");
  const me = gs.players.find((p) => p.id === HUMAN_ID)!;
  const legal = useMemo(
    () => (isMyTurn && gs.dice ? legalTokenIds(me, gs.dice) : []),
    [isMyTurn, me, gs.dice]
  );

  const rollDice = useCallback(() => {
    if (!isMyTurn || gs.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      const result = Math.floor(Math.random() * 6) + 1;
      setRolling(false);
      dispatch({ type: "ROLL", result });
    }, 700);
  }, [isMyTurn, gs.dice, rolling]);

  // Bot automation
  useEffect(() => {
    if (!isBot || phase === "finished") return;
    const delay = 900 + Math.random() * 600;
    if (gs.dice === null) {
      const t = setTimeout(() => {
        const result = Math.floor(Math.random() * 6) + 1;
        dispatch({ type: "ROLL", result });
      }, delay);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => {
        const tokenId = pickBotToken(gs, gs.currentPlayerId!, gs.dice!);
        if (tokenId === -1) dispatch({ type: "ADVANCE" });
        else dispatch({ type: "MOVE", playerId: gs.currentPlayerId!, tokenId });
      }, delay);
      return () => clearTimeout(t);
    }
  }, [isBot, gs.currentPlayerId, gs.dice, phase]);

  // Human auto-advance when no legal moves
  useEffect(() => {
    if (!isMyTurn || phase === "finished" || gs.dice === null) return;
    if (legal.length === 0) {
      const t = setTimeout(() => {
        dispatch({ type: "ADVANCE" });
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [isMyTurn, phase, gs.dice, legal.length]);

  const currentPlayer = gs.players.find((p) => p.id === gs.currentPlayerId);
  const winner = phase === "finished" ? gs.players.find((p) => p.id === gs.winnerId) : null;

  return (
    <div className="game-root">
      <header className="game-header">
        <button className="btn-ghost btn-sm" onClick={onExit}>← Exit</button>
        <div className="turn-info">
          <span className={`turn-dot ${currentPlayer?.color}`} />
          <span>{isMyTurn ? "Your Turn!" : `${currentPlayer?.name}'s turn`}</span>
        </div>
        <div className="scoreboard-mini">
          {gs.players.map((p) => (
            <span key={p.id} className="score-chip">
              <span className={`dot-sm ${p.color}`} />
              {p.tokens.filter((t) => t.position === 56).length}/4
            </span>
          ))}
        </div>
      </header>

      {winner && (
        <div className="winner-banner">
          <div className="winner-content">
            <div className="trophy">🏆</div>
            <h2>{winner.id === HUMAN_ID ? "You Win!" : `${winner.name} Wins!`}</h2>
            <p>What a game! 🎲</p>
            <button className="btn-primary" onClick={onExit}>Play Again</button>
          </div>
        </div>
      )}

      <div className="game-layout">
        <div className="board-container">
          <Board
            players={gs.players}
            currentPlayerId={gs.currentPlayerId}
            dice={gs.dice}
            legalIds={legal}
            onMove={(tokenId) =>
              dispatch({ type: "MOVE", playerId: HUMAN_ID, tokenId })
            }
          />
        </div>
        <aside className="controls-panel card-3d">
          <Dice3D
            value={gs.dice}
            rolling={rolling}
            onClick={rollDice}
            disabled={!isMyTurn || gs.dice !== null || rolling}
          />
          <p className="hint-text">
            {isMyTurn
              ? gs.dice
                ? legal.length > 0
                  ? "✨ Click a pulsing token to move!"
                  : "No legal moves — skipping…"
                : "🎲 Click the dice to roll!"
              : `⏳ ${currentPlayer?.name} is thinking…`}
          </p>
          <div className="scoreboard-full">
            <p className="section-label">SCORES</p>
            {gs.players.map((p) => (
              <div key={p.id} className={`score-row${p.id === gs.currentPlayerId ? " active-score" : ""}`}>
                <span className={`dot-sm ${p.color}`} />
                <span className="score-name">{p.id === HUMAN_ID ? "You" : p.name}</span>
                <div className="token-pips">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={`pip ${p.color}${p.tokens[i]?.position === 56 ? " pip-done" : p.tokens[i]?.position > 0 ? " pip-on" : ""}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Multiplayer Game ────────────────────────────────────────────────────────
function MultiplayerEntry({ onExit }: { onExit: () => void }) {
  const [socket] = useState<AppSocket>(() => io(SERVER, { autoConnect: false }));
  const [sessionId] = useState(() => {
    const key = "ludo-friends-session";
    let saved = window.localStorage.getItem(key);
    if (!saved) { saved = crypto.randomUUID(); window.localStorage.setItem(key, saved); }
    return saved;
  });
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [rolling, setRolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState("Connecting…");
  const [toast, setToast] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const previousSnapshot = useRef<RoomSnapshot | null>(null);
  const me = snapshot?.state.players.find((p) => p.id === socket.id);

  useEffect(() => {
    if (!SERVER_CONFIGURED) {
      setConnection("Multiplayer server is not configured yet. Set the VITE_SERVER_URL repository variable.");
      return () => socket.disconnect();
    }
    socket.on("snapshot", setSnapshot);
    const onError = (e: { message: string }) => setError(e.message);
    const onConnect = () => {
      setConnection(""); setError("");
      socket.emit("resumeSession", { sessionId }, (result) => {
        if (result.ok) setConnection("Room restored.");
      });
    };
    const onDisconnect = () => setConnection("Connection lost. Reconnecting…");
    const onConnectError = () => setConnection("Server unavailable. Check the multiplayer server and try again.");
    socket.on("error", onError);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.connect();
    return () => {
      socket.off("snapshot", setSnapshot);
      socket.off("error", onError);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.disconnect();
    };
  }, [socket, sessionId]);

  useEffect(() => {
    if (!snapshot?.state.turnDeadline) return;
    const update = () =>
      setSeconds(
        Math.max(0, Math.ceil((snapshot.state.turnDeadline! - Date.now()) / 1000))
      );
    update();
    const t = window.setInterval(update, 250);
    return () => clearInterval(t);
  }, [snapshot?.state.turnDeadline]);

  useEffect(() => {
    if (!snapshot) return;
    const previous = previousSnapshot.current;
    let message = "";
    if (previous && snapshot.state.dice === 6 && previous.state.dice !== 6) message = "Rolled a 6!";
    if (previous && snapshot.state.players.some((player) => player.connected === false && previous.state.players.find((old) => old.id === player.id)?.connected !== false)) message = "Player disconnected";
    if (previous && snapshot.state.players.some((player) => player.tokens.some((token) => token.position === 0 && (previous.state.players.find((old) => old.id === player.id)?.tokens.find((old) => old.id === token.id)?.position ?? 0) > 0))) message = "Token captured!";
    previousSnapshot.current = snapshot;
    if (!message) return;
    setToast(message);
    const timeout = window.setTimeout(() => setToast(""), 2400);
    if (soundOn && snapshot.state.dice !== null) {
      try {
        const AudioContextClass = window.AudioContext;
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = snapshot.state.dice === 6 ? 880 : 540;
        gain.gain.setValueAtTime(0.06, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(); oscillator.stop(context.currentTime + 0.12);
        oscillator.onended = () => void context.close();
      } catch { /* Audio is an optional enhancement. */ }
    }
    return () => window.clearTimeout(timeout);
  }, [snapshot, soundOn]);

  const create = () => {
    if (busy || !socket.connected) { setError("Waiting for the game server connection."); return; }
    setBusy(true);
    socket.emit("createRoom", { name, sessionId, turnSeconds: 20 }, (r) => {
      setBusy(false); if (!r.ok) setError(r.error.message); else setError("");
    });
  };
  const join = () => {
    if (busy || !socket.connected) { setError("Waiting for the game server connection."); return; }
    setBusy(true);
    socket.emit("joinRoom", { code, name, sessionId }, (r) => {
      setBusy(false); if (!r.ok) setError(r.error.message); else setError("");
    });
  };

  // Hooks run before every conditional screen return to keep their order stable.
  const legal = useMemo(() => {
    const roll = snapshot?.state.dice;
    return me && roll ? legalTokenIds(me, roll) : [];
  }, [me, snapshot?.state.dice]);

  if (!snapshot) {
    return (
      <div className="entry-screen">
        <button className="btn-ghost btn-sm back-btn" onClick={onExit}>← Back</button>
        <div className="entry-card card-3d">
          <p className="eyebrow">MULTIPLAYER</p>
          <h2>Join the race</h2>
          <label>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Maya"
              maxLength={24}
            />
          </label>
          <button className="btn-primary" disabled={!name.trim() || busy || !socket.connected} onClick={create}>
            🏠 Create a Room
          </button>
          <div className="divider">or join with code</div>
          <div className="join-row">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
              className="code-input"
            />
            <button
              className="btn-primary"
              disabled={!name.trim() || code.length !== 6 || busy || !socket.connected}
              onClick={join}
            >
              Join
            </button>
          </div>
          {error && <p className="error-msg">{error}</p>}
          {connection && <p className="hint-text" role="status">{connection}</p>}
        </div>
      </div>
    );
  }

  if (snapshot.state.phase === "lobby") {
    const choose = (color: Color) =>
      socket.emit("selectColor", { color }, (r) => {
        if (!r.ok) setError(r.error.message);
      });
    return (
      <div className="entry-screen">
        <header className="game-header">
          <button className="btn-ghost btn-sm" onClick={onExit}>← Exit</button>
          <div>
            <span className="eyebrow">ROOM CODE</span>
            <strong className="room-code-display">{snapshot.code}</strong>
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() => navigator.clipboard?.writeText(snapshot.code).then(() => setError("Room code copied.")).catch(() => setError("Could not copy. Select the room code to copy it."))}
          >
            📋 Copy
          </button>
          <button className="btn-ghost btn-sm" onClick={() => { const invite = `${window.location.origin}${window.location.pathname} room code: ${snapshot.code}`; window.open(`https://wa.me/?text=${encodeURIComponent(invite)}`, "_blank", "noopener,noreferrer"); }}>Share</button>
        </header>
        <div className="entry-card card-3d">
          <p className="eyebrow">LOBBY • {snapshot.state.players.length}/4 players</p>
          <h2>Choose your color</h2>
          <p className="hint-text">Everyone marks ready; the host starts when the room is set.</p>
          <div className="players-list">
            {snapshot.state.players.map((p) => (
              <div key={p.id} className="player-row">
                <span className={`dot-sm ${p.color}`} />
                <div className="player-info">
                  <strong>{p.name}{p.id === me?.id ? " (you)" : ""}</strong>
                  <small>{p.ready ? "Ready ✓" : "Picking color…"}</small>
                </div>
                <span className={`ready-badge${p.ready ? " ready" : ""}`}>
                  {p.ready ? "✓" : "…"}
                </span>
              </div>
            ))}
          </div>
          <div className="color-picker">
            {COLORS.map((color) => (
              <button
                key={color}
                className={`color-btn ${color}${me?.color === color ? " selected" : ""}`}
                disabled={snapshot.state.players.some(
                  (p) => p.color === color && p.id !== me?.id
                )}
                onClick={() => choose(color)}
              >
                {color}
              </button>
            ))}
          </div>
          <button
            className={`btn-primary ready-btn${me?.ready ? " is-ready" : ""}`}
            onClick={() =>
              socket.emit("setReady", { ready: !me?.ready }, (r) => { if (!r.ok) setError(r.error.message); })
            }
          >
            {me?.ready ? "✓ Ready!" : "Ready Up"}
          </button>
          {me?.id === snapshot.hostId && <button className="btn-secondary ready-btn" disabled={snapshot.state.players.length < 2 || snapshot.state.players.some((p) => !p.ready || !p.connected)} onClick={() => socket.emit("startGame", (r) => { if (!r.ok) setError(r.error.message); })}>Start Game</button>}
          <button className="btn-ghost btn-sm" onClick={() => socket.emit("leaveRoom", () => onExit())}>Leave room</button>
          {error && <p className="error-msg">{error}</p>}
        </div>
      </div>
    );
  }

  // Playing
  const current = snapshot.state.currentPlayerId === me?.id;

  const doRoll = () => {
    if (!current || snapshot.state.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      setRolling(false);
      socket.emit("rollDice", (r) => { if (!r.ok) setError(r.error.message); });
    }, 700);
  };

  const currentPlayer = snapshot.state.players.find(
    (p) => p.id === snapshot.state.currentPlayerId
  );

  return (
    <div className="game-root">
      <header className="game-header">
        <button className="btn-ghost btn-sm" onClick={onExit}>← Exit</button>
        <div className="turn-info">
          <span className={`turn-dot ${currentPlayer?.color}`} />
          <span>{current ? "Your Turn!" : `${currentPlayer?.name}'s turn`}</span>
        </div>
        <div className="timer-badge">{seconds}s</div>
        <button className="btn-ghost btn-sm" aria-label={soundOn ? "Turn sound off" : "Turn sound on"} onClick={() => setSoundOn((enabled) => !enabled)}>{soundOn ? "🔊" : "🔇"}</button>
      </header>
      <div className="event-toast" role="status" aria-live="polite">{toast}</div>

      {snapshot.state.winnerId && (
        <div className="winner-banner">
          <div className="winner-content">
            <div className="trophy">🏆</div>
            <h2>
              {snapshot.state.winnerId === me?.id
                ? "You Win!"
                : `${snapshot.state.players.find((p) => p.id === snapshot.state.winnerId)?.name} Wins!`}
            </h2>
            <button className="btn-primary" onClick={() => socket.emit("leaveRoom", () => onExit())}>Leave</button>
            {me?.id === snapshot.hostId && <button className="btn-secondary" onClick={() => socket.emit("playAgain", (r) => { if (!r.ok) setError(r.error.message); })}>Play Again</button>}
          </div>
        </div>
      )}

      <div className="game-layout">
        <div className="board-container">
          <Board
            players={snapshot.state.players}
            currentPlayerId={snapshot.state.currentPlayerId}
            dice={snapshot.state.dice}
            legalIds={legal}
            onMove={(tokenId) =>
              socket.emit("moveToken", { tokenId }, (r) => { if (!r.ok) setError(r.error.message); })
            }
          />
        </div>
        <aside className="controls-panel card-3d">
          <Dice3D
            value={snapshot.state.dice}
            rolling={rolling}
            onClick={doRoll}
            disabled={!current || snapshot.state.dice !== null || rolling}
          />
          <p className="hint-text">
            {current
              ? snapshot.state.dice
                ? "✨ Click a pulsing token!"
                : "🎲 Click to roll!"
              : `⏳ ${currentPlayer?.name} is rolling…`}
          </p>
          <div className="scoreboard-full">
            <p className="section-label">SCORES</p>
            {snapshot.state.players.map((p) => (
              <div
                key={p.id}
                className={`score-row${p.id === snapshot.state.currentPlayerId ? " active-score" : ""}`}
              >
                <span className={`dot-sm ${p.color}`} />
                <span className="score-name">
                  {p.id === me?.id ? "You" : p.name}
                </span>
                <div className="token-pips">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={`pip ${p.color}${p.tokens[i]?.position === 56 ? " pip-done" : p.tokens[i]?.position > 0 ? " pip-on" : ""}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="error-msg">{error}</p>}
        </aside>
      </div>
    </div>
  );
}

// ─── Main Menu ────────────────────────────────────────────────────────────────
function Menu({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        window.matchMedia("(pointer: coarse)").matches || navigator.hardwareConcurrency <= 2) return;
    let frame = 0;
    const pointer = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = root.getBoundingClientRect();
        const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
        root.style.setProperty("--tilt-x", `${x * 2}deg`);
        root.style.setProperty("--tilt-y", `${-y * 2}deg`);
      });
    };
    const scroll = () => root.style.setProperty("--scroll-lift", `${Math.max(-16, Math.min(10, window.scrollY * 0.025))}px`);
    window.addEventListener("pointermove", pointer, { passive: true });
    window.addEventListener("scroll", scroll, { passive: true });
    scroll();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", pointer);
      window.removeEventListener("scroll", scroll);
    };
  }, []);
  return (
    <div className="menu-root" ref={rootRef}>
      <div className="menu-bg">
        <div className="floating-token t1">🔴</div>
        <div className="floating-token t2">🟢</div>
        <div className="floating-token t3">🟡</div>
        <div className="floating-token t4">🔵</div>
      </div>
      <div className="menu-content">
        <div className="logo-section">
          <div className="logo-dice">🎲</div>
          <h1 className="logo-title">Play Ludo <span>with Friends</span></h1>
          <p className="logo-sub">Roll the dice, race your tokens home, and make game night anywhere.</p>
          <div className="landing-pills"><span>2–4 players</span><span>Instant rooms</span><span>Play solo with bots</span></div>
        </div>
        <div className="landing-board" aria-hidden="true">
          <div className="landing-orbit orbit-red"><i /><i /><i /><i /></div>
          <div className="landing-orbit orbit-green"><i /><i /><i /><i /></div>
          <div className="landing-orbit orbit-yellow"><i /><i /><i /><i /></div>
          <div className="landing-orbit orbit-blue"><i /><i /><i /><i /></div>
          <div className="landing-route route-a" /><div className="landing-route route-b" />
          <div className="landing-center">✦</div>
          <span className="landing-token token-a">●</span><span className="landing-token token-b">●</span>
          <span className="landing-token token-c">●</span><span className="landing-token token-d">●</span>
        </div>
        <div className="menu-cards">
          <div className="menu-card card-3d" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect("bot"); }} onClick={() => onSelect("bot")}>
            <div className="menu-card-icon">🤖</div>
            <h3>Play vs Bots</h3>
            <p>Face 3 AI opponents. No friends needed — we got you!</p>
            <span className="btn-primary card-cta">Play vs Bots →</span>
          </div>
          <div className="menu-card card-3d" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect("multiplayer"); }} onClick={() => onSelect("multiplayer")}>
            <div className="menu-card-icon">🌐</div>
            <h3>Multiplayer</h3>
            <p>Create or join a room. Play with 2–4 friends online.</p>
            <span className="btn-secondary card-cta">Create or Join Room →</span>
          </div>
        </div>
        <div className="rules-strip">
          <span>🎯 Get all 4 tokens home to win</span>
          <span>🎲 Roll a 6 to leave the yard</span>
          <span>💥 Land on opponents to send them back</span>
        </div>
        <section className="landing-info" aria-label="How to play">
          <h2>Game night in three steps</h2>
          <div className="info-grid"><article><b>01 · Make a room</b><p>Create a private room and share its code.</p></article><article><b>02 · Invite your crew</b><p>Two to four players join from any device.</p></article><article><b>03 · Roll and race</b><p>Get every token home before your friends do.</p></article></div>
          <p className="feature-line">Online with friends · Play against bots · Private room codes · No signup</p>
        </section>
        <footer className="landing-footer">Ludo Friends <span>Made for game night.</span></footer>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode] = useState<Mode>("menu");
  if (mode === "bot") return <BotGame onExit={() => setMode("menu")} />;
  if (mode === "multiplayer") return <MultiplayerEntry onExit={() => setMode("menu")} />;
  return <Menu onSelect={setMode} />;
}


