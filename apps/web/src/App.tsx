import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, User, Users, LogOut, Dice5, Crown, Info } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
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
import {
  createOfflineSession,
  decodeOfflineSession,
  encodeOfflineSession,
  type OfflineSession,
} from "@ludo/shared";

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function colorClasses(color: Color) {
  return {
    red: "bg-red-500 text-red-50",
    green: "bg-green-500 text-green-50",
    yellow: "bg-yellow-400 text-yellow-950",
    blue: "bg-blue-500 text-blue-50",
  }[color];
}

function PlayerCard({
  player,
  active,
  isYou = false,
  showReady = false,
  compact = false,
}: {
  player: Player;
  active: boolean;
  isYou?: boolean;
  showReady?: boolean;
  compact?: boolean;
}) {
  const homeCount = player.tokens.filter((token) => token.position === 56).length;
  const progress = player.tokens.map((token) => token.position === 56 ? 100 : Math.min(92, Math.round((token.position / 56) * 100)));

  return (
    <div className={cn("player-card", active && "player-card-active", compact && "player-card-compact")}>
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("player-avatar", colorClasses(player.color))}>
          {player.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold text-sm">{player.name}</span>
            {isYou && <span className="player-you">You</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className={cn("player-status-dot", player.connected ? "bg-emerald-400" : "bg-amber-400")} />
            <span>{player.connected ? (active ? "Playing now" : `${homeCount}/4 home`) : "Reconnecting…"}</span>
          </div>
        </div>
      </div>
      {showReady ? (
        <span className={cn("player-ready", player.ready ? "player-ready-on" : "player-ready-off")}>
          {player.ready ? "Ready" : "Waiting"}
        </span>
      ) : (
        <div className="player-progress" aria-label={`${homeCount} of 4 tokens home`}>
          {progress.map((value, index) => (
            <span key={index} className="player-progress-track">
              <span className={cn("player-progress-fill", colorClasses(player.color))} style={{ width: `${value}%` }} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SERVER_CONFIGURED = Boolean(import.meta.env.VITE_SERVER_URL) || import.meta.env.DEV;
const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Mode = "menu" | "bot" | "multiplayer";
const OFFLINE_STORAGE_KEY = "ludo-friends-offline-game";

// ─── Bot AI Logic ──────────────────────────────────────────────────────────────────
function scoreBotMove(state: GameState, botId: string, tokenId: number, roll: number): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const token = bot.tokens.find((t) => t.id === tokenId)!;
  let score = 0;
  const newPos = token.position === 0 ? 1 : token.position + roll;
  if (newPos === 56) score += 200;
  if (token.position === 0) score += 50;
  const cell = publicCell(bot.color, newPos as never);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    for (const opp of state.players) {
      if (opp.id === botId) continue;
      for (const ot of opp.tokens) {
        if (publicCell(opp.color, ot.position) === cell) score += 100;
      }
    }
  }
  score += newPos;
  return score;
}

function pickBotToken(state: GameState, botId: string, roll: number): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const legal = legalTokenIds(bot, roll);
  if (legal.length === 0) return -1;
  return legal.reduce((best, id) =>
    scoreBotMove(state, botId, id, roll) > scoreBotMove(state, botId, best, roll) ? id : best
  );
}

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

function makeBotInitialState(saved?: OfflineSession | null): BotState {
  if (saved?.humanId === HUMAN_ID && saved.state.players.length === 4) {
    return { gameState: saved.state, phase: saved.state.phase === "finished" ? "finished" : "playing" };
  }
  const gs = createGameState();
  gs.players.push(createPlayer(HUMAN_ID, "You", "red"));
  BOT_IDS.forEach((id, i) => gs.players.push(createPlayer(id, `Bot ${i + 1}`, BOT_COLORS[i])));
  gs.phase = "playing";
  gs.currentPlayerId = HUMAN_ID;
  return { gameState: gs, phase: "playing" };
}

function loadOfflineState(): BotState {
  if (typeof window === "undefined") return makeBotInitialState();
  const saved = decodeOfflineSession(window.localStorage.getItem(OFFLINE_STORAGE_KEY));
  return makeBotInitialState(saved);
}

function botReducer(state: BotState, action: BotAction): BotState {
  if (state.phase === "finished") return state;
  const gs = structuredClone(state.gameState) as GameState;

  switch (action.type) {
    case "ROLL": {
      if (gs.dice !== null) return state;
      gs.dice = action.result;
      gs.consecutiveSixes = action.result === 6 ? gs.consecutiveSixes + 1 : 0;
      if (gs.consecutiveSixes >= 3) {
        gs.dice = null;
        gs.consecutiveSixes = 0;
        const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
        gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      } else {
        const current = gs.players.find((player) => player.id === gs.currentPlayerId);
        if (current && legalTokenIds(current, action.result).length === 0) {
          gs.dice = null;
          if (action.result !== 6) {
            const idx = gs.players.findIndex((player) => player.id === gs.currentPlayerId);
            gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
            gs.consecutiveSixes = 0;
          }
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

// ─── Components ──────────────────────────────────────────────────────────────────

function Dice3D({ value, rolling, onClick, disabled }: { value: number | null; rolling: boolean; onClick: () => void; disabled: boolean }) {
  const [display, setDisplay] = useState(value ?? 1);
  useEffect(() => {
    if (rolling) {
      const interval = setInterval(() => setDisplay(Math.floor(Math.random() * 6) + 1), 80);
      return () => clearInterval(interval);
    } else if (value !== null) {
      setDisplay(value);
    }
  }, [rolling, value]);

  return (
    <motion.button
      whileHover={!disabled ? { scale: 1.1 } : {}}
      whileTap={!disabled ? { scale: 0.9 } : {}}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "dice-cube relative w-20 h-20 bg-white text-slate-900 rounded-2xl shadow-xl flex items-center justify-center text-4xl font-bold transition-all",
        rolling && "animate-bounce",
        disabled && "opacity-50 cursor-not-allowed grayscale"
      )}
    >
      {["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][display - 1]}
      {rolling && <div className="absolute inset-0 rounded-2xl bg-white/30 animate-pulse" />}
    </motion.button>
  );
}

// Coordinates mapping for the board
const TRACK_COORDS: readonly [number, number][] = [[1,6],[2,6],[3,6],[4,6],[5,6],[6,5],[6,4],[6,3],[6,2],[6,1],[6,0],[7,0],[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[9,6],[10,6],[11,6],[12,6],[13,6],[14,6],[14,7],[14,8],[13,8],[12,8],[11,8],[10,8],[9,8],[8,9],[8,10],[8,11],[8,12],[8,13],[8,14],[7,14],[6,14],[6,13],[6,12],[6,11],[6,10],[6,9],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],[0,7],[0,6]];
const HOME_LANE_COORDS: Record<Color, readonly [number, number][]> = {
  red: [[3, 7], [4, 7], [5, 7]], green: [[7, 3], [7, 4], [7, 5]],
  yellow: [[11, 7], [10, 7], [9, 7]], blue: [[7, 11], [7, 10], [7, 9]],
};

function Board({ players, currentPlayerId, dice, legalIds, onMove }: { players: Player[]; currentPlayerId: string | null; dice: number | null; legalIds: number[]; onMove: (tokenId: number) => void }) {
  const cells = useMemo(() => {
    const map = new Map<number, { player: Player; token: Token }[]>();
    players.forEach((player) =>
      player.tokens.forEach((token) => {
        const cell = publicCell(player.color, token.position);
        if (cell !== null) map.set(cell, [...(map.get(cell) ?? []), { player, token }]);
      })
    );
    return map;
  }, [players]);

  const yardTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const yard = p.tokens.filter((t) => t.position === 0);
      if (yard.length) map.set(p.id, yard);
    });
    return map;
  }, [players]);

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

  const homeTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const home = p.tokens.filter((t) => t.position === 56);
      if (home.length) map.set(p.id, home);
    });
    return map;
  }, [players]);

  const getPlayerByColor = (color: Color) => players.find((p) => p.color === color);

  return (
    <div className="board-stage">
      <div className="board-surface relative w-full h-full bg-slate-700 rounded-lg overflow-hidden grid grid-cols-15 grid-rows-15 gap-px">

        {/* Corner Home Zones */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const player = getPlayerByColor(color);
          const yardToks = player ? yardTokens.get(player.id) ?? [] : [];
          const zoneStyle = {
            red: "top-0 left-0 w-[40%] h-[40%] bg-red-500/20",
            green: "top-0 right-0 w-[40%] h-[40%] bg-green-500/20",
            blue: "bottom-0 left-0 w-[40%] h-[40%] bg-blue-500/20",
            yellow: "bottom-0 right-0 w-[40%] h-[40%] bg-yellow-500/20",
          }[color];

          return (
            <div key={color} className={cn("board-zone absolute p-4 rounded-xl border-2 border-white/10", zoneStyle)}>
              <div className="text-[10px] font-bold opacity-50 uppercase mb-2">{color}</div>
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((slot) => {
                  const tok = yardToks[slot];
                  const isLegal = tok && player?.id === currentPlayerId && legalIds.includes(tok.id);
                  return (
                    <div key={slot} className="aspect-square bg-black/20 rounded-full flex items-center justify-center">
                      {tok && (
                        <motion.button
                          whileHover={isLegal ? { scale: 1.2 } : {}}
                          onClick={() => isLegal && onMove(tok.id)}
                          className={cn(
                            "token-3d w-full h-full rounded-full text-white font-bold text-xs shadow-lg transition-all",
                            color === 'red' ? 'bg-red-500' : color === 'green' ? 'bg-green-500' : color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500',
                            isLegal && "ring-4 ring-white animate-pulse scale-110"
                          )}
                        >
                          {tok.id + 1}
                        </motion.button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Center Finish */}
        <div className="board-center-3d absolute inset-[40%] flex items-center justify-center bg-slate-900 rounded-2xl border-2 border-slate-700 shadow-inner">
          <div className="text-center">
            <div className="text-3xl mb-1">★</div>
            <div className="text-[10px] font-black text-slate-500">FINISH</div>
          </div>
        </div>

        {/* Track Cells */}
        {TRACK_COORDS.map((coord, i) => {
          const cellId = i + 1;
          const tokensOnCell = cells.get(cellId) ?? [];
          const isSafe = SAFE_CELLS.has(cellId);
          return (
            <div
              key={cellId}
              className={cn(
                "absolute w-[6.66%] h-[6.66%] border border-slate-700/30 flex items-center justify-center",
                isSafe && "bg-white/5"
              )}
              style={{ left: `${coord[0] * 100 / 15}%`, top: `${coord[1] * 100 / 15}%` }}
            >
              {isSafe && <div className="absolute inset-0 flex items-center justify-center text-white/10 text-xs">⭐</div>}
              <div className="flex flex-wrap gap-0.5 justify-center items-center">
                {tokensOnCell.map(({ player, token }) => {
                  const isLegal = player.id === currentPlayerId && legalIds.includes(token.id);
                  return (
                    <motion.button
                      key={`${player.id}-${token.id}`}
                      whileHover={isLegal ? { scale: 1.2 } : {}}
                      onClick={() => isLegal && onMove(token.id)}
                      className={cn(
                        "token-3d w-3 h-3 rounded-full text-[8px] text-white font-bold shadow-sm transition-all",
                        player.color === 'red' ? 'bg-red-500' : player.color === 'green' ? 'bg-green-500' : player.color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500',
                        isLegal && "ring-2 ring-white animate-pulse scale-125"
                      )}
                    >
                      {token.id + 1}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Home Runway Cells */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          return [53, 54, 55].map((pos) => {
            const list = laneTokens.get(`${color}-${pos}`) ?? [];
            return (
              <div
                key={`${color}-${pos}`}
                className="absolute w-[6.66%] h-[6.66%] border border-slate-700/30 flex items-center justify-center bg-white/5"
                style={{ left: `${HOME_LANE_COORDS[color][pos - 53][0] * 100 / 15}%`, top: `${HOME_LANE_COORDS[color][pos - 53][1] * 100 / 15}%` }}
              >
                <div className="flex flex-wrap gap-0.5 justify-center items-center">
                  {list.map(({ player, token }) => {
                    const isLegal = player.id === currentPlayerId && legalIds.includes(token.id);
                    return (
                      <motion.button
                        key={`${player.id}-${token.id}`}
                        whileHover={isLegal ? { scale: 1.2 } : {}}
                        onClick={() => isLegal && onMove(token.id)}
                        className={cn(
                          "token-3d w-3 h-3 rounded-full text-[8px] text-white font-bold shadow-sm transition-all",
                          player.color === 'red' ? 'bg-red-500' : player.color === 'green' ? 'bg-green-500' : player.color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500',
                          isLegal && "ring-2 ring-white animate-pulse scale-125"
                        )}
                      >
                        {token.id + 1}
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}

function BotGame({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(botReducer, null, loadOfflineState);
  const [rolling, setRolling] = useState(false);
  const { gameState: gs, phase } = state;
  const isMyTurn = gs.currentPlayerId === HUMAN_ID;
  const isBot = BOT_IDS.includes(gs.currentPlayerId ?? "");
  const me = gs.players.find((p) => p.id === HUMAN_ID)!;
  const legal = useMemo(() => (isMyTurn && gs.dice ? legalTokenIds(me, gs.dice) : []), [isMyTurn, me, gs.dice]);

  useEffect(() => {
    window.localStorage.setItem(
      OFFLINE_STORAGE_KEY,
      encodeOfflineSession(createOfflineSession(gs, HUMAN_ID)),
    );
  }, [gs]);

  const rollDice = useCallback(() => {
    if (!isMyTurn || gs.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      const result = Math.floor(Math.random() * 6) + 1;
      setRolling(false);
      dispatch({ type: "ROLL", result });
    }, 700);
  }, [isMyTurn, gs.dice, rolling]);

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

  const currentPlayer = gs.players.find((p) => p.id === gs.currentPlayerId);
  const winner = phase === "finished" ? gs.players.find((p) => p.id === gs.winnerId) : null;

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-8 flex flex-col items-center">
      <header className="w-full max-w-6xl flex justify-between items-center mb-8">
        <button onClick={onExit} className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-sm">
          <LogOut size={16} /> Exit Game
        </button>
        <div className="flex items-center gap-3 text-2xl font-black tracking-tighter">
          <span className="text-4xl">🎲</span> LUDO<span className="text-blue-500">FRIENDS</span>
        </div>
        <div className="flex items-center gap-4 bg-slate-800 px-4 py-2 rounded-full border border-slate-700">
          <div className={cn("w-3 h-3 rounded-full animate-pulse", currentPlayer?.color === 'red' ? 'bg-red-500' : currentPlayer?.color === 'green' ? 'bg-green-500' : currentPlayer?.color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500')} />
          <span className="text-sm font-medium">{isMyTurn ? "Your Turn" : `${currentPlayer?.name}'s Turn`}</span>
        </div>
      </header>

      <AnimatePresence>
        {winner && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          >
            <div className="bg-slate-900 p-12 rounded-3xl border-4 border-yellow-500 text-center shadow-[0_0_50px_rgba(234,179,8,0.3)]">
              <Trophy size={80} className="mx-auto text-yellow-500 mb-4 animate-bounce" />
              <h2 className="text-5xl font-black mb-2">{winner?.id === HUMAN_ID ? "YOU WIN!" : `${winner?.name} WINS!`}</h2>
              <p className="text-slate-400 mb-8 text-lg">A legendary victory! 🎲</p>
              <button onClick={() => {
                window.localStorage.removeItem(OFFLINE_STORAGE_KEY);
                onExit();
              }} className="px-8 py-4 bg-yellow-500 text-slate-950 font-bold rounded-2xl hover:bg-yellow-400 transition-all transform hover:scale-105">
                New Game
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 flex justify-center">
          <Board
            players={gs.players}
            currentPlayerId={gs.currentPlayerId}
            dice={gs.dice}
            legalIds={legal}
            onMove={(id) => dispatch({ type: "MOVE", playerId: HUMAN_ID, tokenId: id })}
          />
        </div>

        <aside className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-xs font-bold tracking-widest">
              <Dice5 size={14} /> Game Controls
            </div>
            <div className="flex flex-col items-center gap-6">
              <Dice3D
                value={gs.dice}
                rolling={rolling}
                onClick={rollDice}
                disabled={!isMyTurn || gs.dice !== null || rolling}
              />
              <p className="text-center text-slate-400 italic">
                {isMyTurn
                  ? gs.dice ? (legal.length > 0 ? "Select a pulsing token to move!" : "No legal moves, skipping...") : "Roll the dice to start!"
                  : `${currentPlayer?.name} is thinking...`}
              </p>
            </div>
          </div>

          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-xs font-bold tracking-widest">
              <Users size={14} /> Leaderboard
            </div>
            <div className="space-y-3">
              {gs.players.map((p) => (
                <PlayerCard key={p.id} player={p} active={p.id === gs.currentPlayerId} isYou={p.id === HUMAN_ID} />
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

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
      setConnection("Server not configured. Check VITE_SERVER_URL.");
      return () => socket.disconnect();
    }
    socket.on("snapshot", setSnapshot);
    const onConnect = () => {
      setConnection("Connected. Restoring your room…"); setError("");
      socket.emit("resumeSession", { sessionId }, (result) => {
        setConnection(result.ok ? "Room restored." : "Connected. Create or join a room.");
      });
    };
    const onConnectError = () => setConnection("Server unavailable. Check backend.");
    const onDisconnect = () => setConnection("Connection lost. Reconnecting…");
    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.connect();
    return () => {
      socket.off("snapshot", setSnapshot);
      socket.off("disconnect", onDisconnect);
      socket.disconnect();
    };
  }, [socket, sessionId]);

  useEffect(() => {
    if (!snapshot?.state.turnDeadline) return;
    const update = () => setSeconds(Math.max(0, Math.ceil((snapshot.state.turnDeadline! - Date.now()) / 1000)));
    update();
    const t = window.setInterval(update, 250);
    return () => clearInterval(t);
  }, [snapshot?.state.turnDeadline]);

  const create = () => {
    if (busy || !socket.connected) return;
    setBusy(true);
    socket.emit("createRoom", { name, sessionId, turnSeconds: 20 }, (r) => {
      setBusy(false); if (!r.ok) setError(r.error.message);
    });
  };
  const join = () => {
    if (busy || !socket.connected) return;
    setBusy(true);
    socket.emit("joinRoom", { code, name, sessionId }, (r) => {
      setBusy(false); if (!r.ok) setError(r.error.message);
    });
  };

  const legal = useMemo(() => {
    const roll = snapshot?.state.dice;
    return me && roll ? legalTokenIds(me, roll) : [];
  }, [me, snapshot?.state.dice]);

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl relative">
          <button onClick={onExit} className="absolute -top-12 left-0 text-slate-400 hover:text-white flex items-center gap-2 text-sm">
            <LogOut size={14} /> Back to Menu
          </button>
          <div className="text-center mb-8">
            <p className="text-blue-500 font-bold text-xs uppercase tracking-widest mb-2">Multiplayer</p>
            <h2 className="text-3xl font-black">Join the Race</h2>
          </div>
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase ml-1">Your Name</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maya" className="w-full bg-slate-800 border border-slate-700 p-3 rounded-xl focus:ring-2 ring-blue-500 outline-none transition-all"
              />
            </div>
            <button
              disabled={!name.trim() || busy || !socket.connected} onClick={create}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-bold rounded-xl transition-all transform hover:scale-[1.02]"
            >
              🏠 Create a Room
            </button>
            <div className="flex items-center gap-4 py-2">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-xs text-slate-600 font-bold uppercase">or join</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>
            <div className="flex gap-2">
              <input
                value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123" className="flex-1 bg-slate-800 border border-slate-700 p-3 rounded-xl uppercase font-mono tracking-widest outline-none"
              />
              <button
                disabled={!name.trim() || code.length !== 6 || busy || !socket.connected} onClick={join}
                className="px-6 py-3 bg-slate-700 hover:bg-slate-600 font-bold rounded-xl transition-all"
              >
                Join
              </button>
            </div>
            {error && <p className="text-red-400 text-center text-sm">{error}</p>}
            {connection && <p className="text-slate-500 text-center text-xs italic">{connection}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (snapshot.state.phase === "lobby") {
    const choose = (color: Color) => socket.emit("selectColor", { color }, (r) => { if (!r.ok) setError(r.error.message); });
    return (
      <div className="min-h-screen bg-slate-950 p-4 md:p-8 flex flex-col items-center">
        <header className="w-full max-w-6xl flex justify-between items-center mb-12">
          <button onClick={onExit} className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-sm">
            <LogOut size={16} /> Exit Lobby
          </button>
          <div className="text-center">
            <span className="text-xs font-bold text-slate-500 uppercase block tracking-widest">Room Code</span>
            <strong className="text-2xl font-black tracking-widest text-blue-400">{snapshot.code}</strong>
          </div>
          <button onClick={() => navigator.clipboard.writeText(snapshot.code)} className="px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-sm">📋 Copy</button>
        </header>
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl">
          <div className="text-center mb-8">
            <p className="text-xs font-bold text-slate-500 uppercase mb-1">Lobby • {snapshot.state.players.length}/4 Players</p>
            <h2 className="text-3xl font-black">Choose Color</h2>
          </div>
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-3">
              {snapshot.state.players.map((p) => (
                <PlayerCard key={p.id} player={p} active={false} isYou={p.id === me?.id} showReady compact />
              ))}
            </div>
            <div className="grid grid-cols-4 gap-3">
              {COLORS.map((color) => (
                <button
                  key={color}
                  disabled={snapshot.state.players.some(p => p.color === color && p.id !== me?.id)}
                  onClick={() => choose(color)}
                  className={cn(
                    "h-12 rounded-xl transition-all transform hover:scale-110",
                    color === 'red' ? 'bg-red-500' : color === 'green' ? 'bg-green-500' : color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500',
                    me?.color === color ? "ring-4 ring-white scale-110" : "opacity-60",
                    "disabled:opacity-20 disabled:cursor-not-allowed"
                  )}
                />
              ))}
            </div>
            <button
              onClick={() => socket.emit("setReady", { ready: !me?.ready }, (r) => { if (!r.ok) setError(r.error.message); })}
              className={cn(
                "w-full py-4 font-bold rounded-2xl transition-all transform hover:scale-[1.02]",
                me?.ready ? "bg-green-600 hover:bg-green-500" : "bg-blue-600 hover:bg-blue-500"
              )}
            >
              {me?.ready ? "✓ Ready!" : "Ready Up"}
            </button>
            {me?.id === snapshot.hostId && (
              <button
                disabled={snapshot.state.players.length < 2 || snapshot.state.players.some(p => !p.ready || !p.connected)}
                onClick={() => socket.emit("startGame", (r) => { if (!r.ok) setError(r.error.message); })}
                className="w-full py-4 bg-yellow-500 text-slate-950 font-bold rounded-2xl disabled:opacity-50 transition-all"
              >
                Start Game
              </button>
            )}
            <button onClick={() => socket.emit("leaveRoom", () => onExit())} className="w-full py-2 text-slate-500 text-sm hover:text-white transition-colors">Leave Room</button>
            {error && <p className="text-red-400 text-center text-sm">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const current = snapshot.state.currentPlayerId === me?.id;
  const doRoll = () => {
    if (!current || snapshot.state.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      setRolling(false);
      socket.emit("rollDice", (r) => { if (!r.ok) setError(r.error.message); });
    }, 700);
  };

  const currentPlayer = snapshot.state.players.find(p => p.id === snapshot.state.currentPlayerId);

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-8 flex flex-col items-center">
      <header className="w-full max-w-6xl flex justify-between items-center mb-8">
        <button onClick={onExit} className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-sm">
          <LogOut size={16} /> Exit
        </button>
        <div className="flex items-center gap-3 text-2xl font-black tracking-tighter">
          <span className="text-4xl">🎲</span> LUDO<span className="text-blue-500">FRIENDS</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="bg-slate-800 px-4 py-2 rounded-full border border-slate-700 flex items-center gap-3">
            <span className="text-xs font-bold text-slate-500 uppercase">Timer</span>
            <strong className="text-xl font-mono">{seconds}s</strong>
          </div>
          <button onClick={() => setSoundOn(!soundOn)} className="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors">
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </header>

      <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-xl"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {snapshot.state.winnerId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 p-12 rounded-3xl border-4 border-yellow-500 text-center shadow-2xl">
            <Trophy size={80} className="mx-auto text-yellow-500 mb-4 animate-bounce" />
            <h2 className="text-5xl font-black mb-4">
              {snapshot.state.winnerId === me?.id ? "You Win!" : `${snapshot.state.players.find(p => p.id === snapshot.state.winnerId)?.name} Wins!`}
            </h2>
            <div className="flex gap-4 justify-center">
              <button onClick={() => socket.emit("leaveRoom", () => onExit())} className="px-8 py-4 bg-slate-800 rounded-2xl font-bold hover:bg-slate-700 transition-all">Leave</button>
              {me?.id === snapshot.hostId && (
                <button onClick={() => socket.emit("playAgain", (r) => { if (!r.ok) setError(r.error.message); })} className="px-8 py-4 bg-yellow-500 text-slate-950 font-bold rounded-2xl hover:bg-yellow-400 transition-all">Play Again</button>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 flex justify-center">
          <Board
            players={snapshot.state.players}
            currentPlayerId={snapshot.state.currentPlayerId}
            dice={snapshot.state.dice}
            legalIds={legal}
            onMove={(tokenId) => socket.emit("moveToken", { tokenId }, (r) => { if (!r.ok) setError(r.error.message); })}
          />
        </div>
        <aside className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-xs font-bold tracking-widest">
              <Dice5 size={14} /> Game Control
            </div>
            <div className="flex flex-col items-center gap-6">
              <Dice3D
                value={snapshot.state.dice}
                rolling={rolling}
                onClick={doRoll}
                disabled={!current || snapshot.state.dice !== null || rolling}
              />
              <p className="text-center text-slate-400 italic">
                {current
                  ? snapshot.state.dice ? "Select a pulsing token!" : "Roll the dice to start!"
                  : `${currentPlayer?.name} is rolling...`}
              </p>
            </div>
          </div>
          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-xs font-bold tracking-widest">
              <Users size={14} /> Online Players
            </div>
            <div className="space-y-3">
              {snapshot.state.players.map((p) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  active={p.id === snapshot.state.currentPlayerId}
                  isYou={p.id === me?.id}
                />
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Menu({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const hasSavedOfflineGame = typeof window !== "undefined" && Boolean(
    decodeOfflineSession(window.localStorage.getItem(OFFLINE_STORAGE_KEY)),
  );

  return (
    <div className="landing-page">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />
      <div className="landing-shell">
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="landing-hero"
        >
          <div className="landing-kicker">
            <span className="landing-mark">LF</span>
            <span>Ludo Friends</span>
            <span className="landing-live"><span /> Live rooms</span>
          </div>
          <h1>
            A small board.<br /><span>A lot of rivalry.</span>
          </h1>
          <p className="landing-lede">A tactile Ludo room for quick matches with friends — or a reliable game when the Wi‑Fi disappears.</p>
          <div className="landing-stats">
            <span><strong>4</strong> players</span>
            <span><strong>1</strong> shared board</span>
            <span><strong>0</strong> accounts</span>
          </div>
        </motion.div>

        <div className="landing-options">
          <motion.button
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            onClick={() => onSelect("bot")}
            className="landing-card landing-card-light group"
          >
            <div className="landing-card-top"><span className="landing-icon">♟</span><span className="landing-pill">{hasSavedOfflineGame ? "Saved locally" : "No account needed"}</span></div>
            <div><h2>{hasSavedOfflineGame ? "Resume offline game" : "Play offline"}</h2><p>Three thoughtful opponents, deterministic rules, and a match that stays on this device.</p></div>
            <span className="landing-action">{hasSavedOfflineGame ? "Continue match" : "Start solo"} <span>→</span></span>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            onClick={() => onSelect("multiplayer")}
            className="landing-card landing-card-dark group"
          >
            <div className="landing-card-top"><span className="landing-icon">◎</span><span className="landing-pill">2–4 players</span></div>
            <div><h2>Make a room</h2><p>Share a short code, choose your colors, and play with the server keeping every move fair.</p></div>
            <span className="landing-action">Create or join <span>→</span></span>
          </motion.button>
        </div>

        <div className="landing-rules">
          <span>4 tokens to finish</span><span>Six to leave yard</span><span>Capture to reset</span>
        </div>
        {hasSavedOfflineGame && <button onClick={() => { window.localStorage.removeItem(OFFLINE_STORAGE_KEY); window.location.reload(); }} className="landing-forget">Forget saved offline game</button>}
      </div>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("menu");
  if (mode === "bot") return <BotGame onExit={() => setMode("menu")} />;
  if (mode === "multiplayer") return <MultiplayerEntry onExit={() => setMode("menu")} />;
  return <Menu onSelect={setMode} />;
}
