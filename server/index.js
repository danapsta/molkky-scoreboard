import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'game-state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PORT = process.env.PORT || 3001;
const MAX_UNDO = 40;

fs.mkdirSync(DATA_DIR, { recursive: true });

const AGE_BRACKETS = [
  { id: 'toddler', label: 'Toddler', range: '0-4', min: 0, max: 4, closerLine: true, missEliminates: false },
  { id: 'children', label: 'Children', range: '5-9', min: 5, max: 9, closerLine: true, missEliminates: false },
  { id: 'preteen', label: 'Pre-Teen', range: '10-14', min: 10, max: 14, closerLine: false, missEliminates: true },
  { id: 'adult', label: 'Adult', range: '15-60', min: 15, max: 60, closerLine: false, missEliminates: true },
  { id: 'senior', label: 'Senior', range: '60+', min: 61, max: 999, closerLine: false, missEliminates: true }
];

function now() { return new Date().toISOString(); }
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function normalizeName(name) { return String(name || '').trim().replace(/\s+/g, ' '); }
function canonicalName(name) { return normalizeName(name).toLowerCase(); }
function uniqueClean(names) { return [...new Set((names || []).map(normalizeName).filter(Boolean))]; }
function getAgeBracket(age) {
  const n = Number(age);
  if (!Number.isFinite(n) || n < 0) return AGE_BRACKETS.find(b => b.id === 'adult');
  return AGE_BRACKETS.find(b => n >= b.min && n <= b.max) || AGE_BRACKETS.find(b => b.id === 'senior');
}
function distanceToTarget(score, target = 50) { return Math.abs(target - Number(score || 0)); }

function defaultHistory() {
  return { version: 2, games: [], tournaments: [], championships: [] };
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback();
    return { ...fallback(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    console.error(`${path.basename(file)} was unreadable. Starting fresh.`, err);
    return fallback();
  }
}

let history = readJson(HISTORY_FILE, defaultHistory);
history.games ||= [];
history.tournaments ||= [];
history.championships ||= [];
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); }

function defaultState() {
  return {
    gameId: nanoid(8),
    createdAt: now(),
    updatedAt: now(),
    targetScore: 50,
    bustScore: 25,
    maxMisses: 3,
    status: 'setup',
    mode: 'individual',
    players: [],
    teams: [],
    currentPlayerIndex: 0,
    currentTeamIndex: 0,
    throwHistory: [],
    eventLog: [],
    undoStack: [],
    winnerId: null,
    winnerType: null,
    archived: false,
    tournament: null,
    championship: null,
    settings: {
      rotateStatsSeconds: 8,
      showMisses: true,
      showNeededToWin: true,
      unlimitedMisses: false
    }
  };
}

let state = readJson(STATE_FILE, defaultState);
state.throwHistory = Array.isArray(state.throwHistory) ? state.throwHistory.map(({ before, undo, ...t }) => t).slice(-500) : [];
state.eventLog = Array.isArray(state.eventLog) ? state.eventLog.slice(-500) : [];
state.undoStack = [];
if (!['setup', 'playing', 'finished'].includes(state.status)) state.status = 'setup';
if (!['individual', 'team', 'tournament', 'championship'].includes(state.mode)) state.mode = 'individual';

function saveState() {
  state.updatedAt = now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function snapshotForUndo() {
  const snap = clone({ ...state, undoStack: [] });
  state.undoStack.push(snap);
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
}

function isTeamMode() { return state.mode === 'team' || state.mode === 'tournament'; }
function participantRows() {
  if (isTeamMode()) return state.teams;
  return state.players;
}
function missesUnlimited(entity) { return !!state.settings?.unlimitedMisses || entity?.missEliminates === false; }
function eliminatedByMisses(entity) {
  return !!entity?.eliminated && !entity.manuallyExcluded && !entity.overtimeExcluded && (entity.misses || 0) >= state.maxMisses;
}
function firstActiveIndexFrom(rows, start) {
  const total = rows.length;
  for (let offset = 0; offset < total; offset++) {
    const index = (start + offset) % total;
    if (!rows[index].eliminated) return index;
  }
  return 0;
}
function logEvent(message) { state.eventLog.push({ id: nanoid(10), at: now(), message }); state.eventLog = state.eventLog.slice(-500); }
function activePlayers() { return state.players.filter(p => !p.eliminated); }
function activeTeams() { return state.teams.filter(t => !t.eliminated); }
function activeRows() { return participantRows().filter(p => !p.eliminated); }

function getCurrentEntity() {
  if (state.mode === 'team' || state.mode === 'tournament') {
    const team = state.teams[state.currentTeamIndex] || null;
    if (!team) return { team: null, player: null };
    const roster = team.players || [];
    const playerName = roster.length ? roster[team.throwerIndex % roster.length] : team.name;
    return { team, player: { id: `${team.id}:${team.throwerIndex}`, name: playerName } };
  }
  return { team: null, player: state.players[state.currentPlayerIndex] || null };
}

function advanceTurn() {
  if (state.status === 'finished') return;
  if (state.mode === 'team' || state.mode === 'tournament') {
    const total = state.teams.length;
    for (let offset = 1; offset <= total; offset++) {
      const nextIndex = (state.currentTeamIndex + offset) % total;
      if (!state.teams[nextIndex].eliminated) {
        state.currentTeamIndex = nextIndex;
        return;
      }
    }
    return;
  }
  const total = state.players.length;
  for (let offset = 1; offset <= total; offset++) {
    const nextIndex = (state.currentPlayerIndex + offset) % total;
    if (!state.players[nextIndex].eliminated) {
      state.currentPlayerIndex = nextIndex;
      return;
    }
  }
}

function calculatePoints(pinsKnocked) {
  const pins = Array.isArray(pinsKnocked) ? pinsKnocked.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 12) : [];
  const uniquePins = [...new Set(pins)];
  if (uniquePins.length === 0) return { points: 0, pinsKnocked: [] };
  if (uniquePins.length === 1) return { points: uniquePins[0], pinsKnocked: uniquePins };
  return { points: uniquePins.length, pinsKnocked: uniquePins };
}

function favoriteNumber() {
  const counts = new Map();
  for (const t of state.throwHistory) for (const p of t.pinsKnocked || []) counts.set(p, (counts.get(p) || 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return best ? { number: best[0], count: best[1] } : null;
}

function championshipPreviousWinners() {
  const champs = history.championships || [];
  const latest = champs[champs.length - 1] || null;
  const byCategory = {};
  if (latest?.categoryWinners) {
    for (const [cat, winner] of Object.entries(latest.categoryWinners)) byCategory[cat] = winner;
  }
  return { latest, byCategory };
}

function championshipDynasty() {
  const counts = new Map();

  for (const c of history.championships || []) {
    const yearKey = c.year || c.finishedAt || c.id;
    const uniqueWinnersThisChampionship = new Map();

    if (c.overallWinner?.name) {
      const key = canonicalName(c.overallWinner.name);
      const entry = uniqueWinnersThisChampionship.get(key) || {
        name: c.overallWinner.name,
        categories: new Set(),
        wasOverall: false
      };
      entry.wasOverall = true;
      if (c.overallWinner.category) entry.categories.add(c.overallWinner.category);
      uniqueWinnersThisChampionship.set(key, entry);
    }

    for (const [category, winner] of Object.entries(c.categoryWinners || {})) {
      if (!winner?.name) continue;
      const key = canonicalName(winner.name);
      const entry = uniqueWinnersThisChampionship.get(key) || {
        name: winner.name,
        categories: new Set(),
        wasOverall: false
      };
      entry.categories.add(category);
      uniqueWinnersThisChampionship.set(key, entry);
    }

    for (const [key, entry] of uniqueWinnersThisChampionship.entries()) {
      const current = counts.get(key) || {
        name: entry.name,
        wins: 0,
        overallWins: 0,
        categoryWins: 0,
        years: [],
        categories: {}
      };

      current.wins += 1; // One championship-year can only count once per person.
      if (entry.wasOverall) current.overallWins += 1;
      if (entry.categories.size) current.categoryWins += 1;
      current.years.push(yearKey);
      for (const category of entry.categories) current.categories[category] = (current.categories[category] || 0) + 1;
      counts.set(key, current);
    }
  }

  return [...counts.values()].sort((a, b) => b.wins - a.wins || b.overallWins - a.overallWins || a.name.localeCompare(b.name)).slice(0, 8);
}

function computeChampionshipCategoryWinners(players = state.players) {
  const result = {};
  for (const bracket of AGE_BRACKETS) {
    const group = players.filter(p => p.category === bracket.id);
    if (!group.length) continue;
    const eligible = group.filter(p => !p.manuallyExcluded);
    const pool = eligible.length ? eligible : group;
    const exact = pool.filter(p => p.score === state.targetScore).sort((a, b) => (a.throws || 0) - (b.throws || 0));
    const best = exact[0] || [...pool].sort((a, b) => distanceToTarget(a.score, state.targetScore) - distanceToTarget(b.score, state.targetScore) || b.score - a.score || a.name.localeCompare(b.name))[0];
    if (best) result[bracket.id] = {
      id: best.id,
      name: best.name,
      age: best.age,
      category: bracket.id,
      categoryLabel: bracket.label,
      score: best.score,
      exact50: best.score === state.targetScore,
      distanceFrom50: distanceToTarget(best.score, state.targetScore),
      throws: best.throws || 0
    };
  }
  return result;
}

function buildStats() {
  const rows = participantRows();
  const ranked = [...rows].filter(p => !p.eliminated).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const { team, player } = getCurrentEntity();
  const current = (state.mode === 'team' || state.mode === 'tournament') ? team : player;
  const last = state.throwHistory[state.throwHistory.length - 1] || null;
  const throws = state.throwHistory;
  const fav = favoriteNumber();
  const totalPoints = throws.reduce((sum, t) => sum + t.points, 0);
  const avgThrow = throws.length ? totalPoints / throws.length : 0;
  const bustLeader = [...rows].sort((a, b) => (b.busts || 0) - (a.busts || 0))[0] || null;
  const missLeader = [...rows].sort((a, b) => (b.misses || 0) - (a.misses || 0))[0] || null;
  const biggestThrow = [...throws].sort((a, b) => b.points - a.points)[0] || null;
  const clutch = ranked.filter(p => state.targetScore - p.score > 0 && state.targetScore - p.score <= 12);
  const danger = rows.filter(p => !p.eliminated && !missesUnlimited(p) && p.misses >= Math.max(1, state.maxMisses - 1));
  const hot = [...rows]
    .filter(p => !p.eliminated)
    .map(p => {
      const recent = throws.filter(t => t.entityId === p.id).slice(-3);
      const avg = recent.length ? recent.reduce((sum, t) => sum + t.points, 0) / recent.length : 0;
      return { ...p, recentAverage: avg };
    })
    .sort((a, b) => b.recentAverage - a.recentAverage)[0] || null;

  const championship = state.mode === 'championship' ? {
    phase: state.championship?.phase || 'normal',
    exact50ThisRound: state.championship?.exact50ThisRound || [],
    turnsRemainingInRound: state.championship?.turnsRemainingInRound || 0,
    categoryWinnersIfEndedNow: computeChampionshipCategoryWinners(),
    previous: championshipPreviousWinners(),
    dynasty: championshipDynasty(),
    brackets: AGE_BRACKETS
  } : null;

  return {
    mode: state.mode,
    currentPlayer: player,
    currentEntity: current,
    currentTeam: team,
    topThree: ranked.slice(0, 3),
    rankedPlayers: ranked,
    eliminatedPlayers: rows.filter(p => p.eliminated),
    closestToWin: ranked[0] ? { ...ranked[0], needs: state.targetScore - ranked[0].score } : null,
    dangerPlayers: danger,
    lastThrow: last,
    hotHand: hot,
    activeCount: state.mode === 'individual' || state.mode === 'championship' ? activePlayers().length : activeTeams().length,
    favoriteNumber: fav,
    averageThrow: avgThrow,
    totalThrows: throws.length,
    totalPoints,
    bustLeader,
    missLeader,
    biggestThrow,
    clutchPlayers: clutch,
    championship,
    historySummary: {
      gamesPlayed: history.games.length,
      recentWinners: history.games.slice(-5).reverse().map(g => g.winnerName).filter(Boolean),
      tournamentsPlayed: history.tournaments.length,
      championshipsPlayed: history.championships.length
    }
  };
}

function emitState(io) { io.emit('state', { state, stats: buildStats(), history }); }
function apiResponse(res) { return res.json({ state, stats: buildStats(), history }); }

function archiveFinishedGame() {
  if (state.status !== 'finished' || state.archived) return;
  const rows = participantRows();
  const winner = rows.find(p => p.id === state.winnerId) || null;
  const baseRecord = {
    id: nanoid(12),
    gameId: state.gameId,
    mode: state.mode,
    tournamentId: state.tournament?.id || null,
    tournamentName: state.tournament?.name || null,
    roundNumber: state.tournament?.roundNumber || null,
    championshipYear: state.championship?.year || null,
    championshipName: state.championship?.name || null,
    startedAt: state.createdAt,
    finishedAt: now(),
    winnerId: winner?.id || null,
    winnerName: winner?.name || null,
    finalScores: rows.map(p => ({ id: p.id, name: p.name, age: p.age, category: p.category, categoryLabel: p.categoryLabel, score: p.score, throws: p.throws || 0, busts: p.busts || 0, misses: p.misses || 0, roundsWon: p.roundsWon || 0, eliminated: !!p.eliminated, manuallyExcluded: !!p.manuallyExcluded })),
    throws: state.throwHistory.map(({ undo, ...t }) => t)
  };

  history.games.push(baseRecord);
  history.games = history.games.slice(-500);

  if (state.mode === 'championship') {
    const categoryWinners = computeChampionshipCategoryWinners();
    const record = {
      ...baseRecord,
      id: nanoid(12),
      year: state.championship?.year || new Date().getFullYear(),
      name: state.championship?.name || 'Yearly Championship',
      overallWinner: winner ? {
        id: winner.id,
        name: winner.name,
        age: winner.age,
        category: winner.category,
        categoryLabel: winner.categoryLabel,
        score: winner.score,
        throws: winner.throws || 0
      } : null,
      categoryWinners,
      overtimeRounds: state.championship?.overtimeRounds || 0
    };
    history.championships.push(record);
    history.championships = history.championships.slice(-100);
  }

  if ((state.mode === 'tournament' || state.mode === 'team') && state.tournament) {
    const existing = history.tournaments.find(t => t.id === state.tournament.id);
    const summary = {
      id: state.tournament.id,
      name: state.tournament.name,
      updatedAt: now(),
      roundsPlayed: state.tournament.roundNumber,
      teams: state.teams.map(t => ({ id: t.id, name: t.name, roundsWon: t.roundsWon || 0 })),
      currentLeader: [...state.teams].sort((a, b) => (b.roundsWon || 0) - (a.roundsWon || 0))[0]?.name || null
    };
    if (existing) Object.assign(existing, summary);
    else history.tournaments.push(summary);
  }

  state.archived = true;
  saveHistory();
}

function maybeFinishChampionshipRound(entity, wonThisThrow) {
  if (state.mode !== 'championship') return false;
  const champ = state.championship;
  if (!champ) return false;

  if (wonThisThrow && !champ.exact50ThisRound.includes(entity.id)) champ.exact50ThisRound.push(entity.id);

  if (wonThisThrow && champ.phase === 'normal') {
    champ.phase = 'finish-round';
    champ.firstExact50Index = state.currentPlayerIndex;
    champ.turnsRemainingInRound = Math.max(0, activePlayers().length - 1);
  } else if (wonThisThrow && champ.phase === 'overtime') {
    champ.phase = 'overtime-finish-round';
    champ.firstExact50Index = state.currentPlayerIndex;
    champ.turnsRemainingInRound = Math.max(0, activePlayers().length - 1);
  } else if (champ.phase === 'finish-round' || champ.phase === 'overtime-finish-round') {
    champ.turnsRemainingInRound = Math.max(0, (champ.turnsRemainingInRound || 0) - 1);
  }

  return resolveChampionshipRoundIfDone();
}

function championshipFinishingRound() {
  const phase = state.championship?.phase;
  return state.mode === 'championship' && (phase === 'finish-round' || phase === 'overtime-finish-round');
}

// The players still owed a throw in a finish-the-round phase are the next
// `turnsRemainingInRound` active players, starting with the current one.
function upcomingChampionshipThrowerIds() {
  if (!championshipFinishingRound()) return [];
  const needed = state.championship.turnsRemainingInRound || 0;
  const ids = [];
  const total = state.players.length;
  for (let offset = 0; offset < total && ids.length < needed; offset++) {
    const p = state.players[(state.currentPlayerIndex + offset) % total];
    if (p && !p.eliminated) ids.push(p.id);
  }
  return ids;
}

// Call BEFORE a player is removed or eliminated outside of a normal throw.
function championshipForgetPlayer(id) {
  if (state.mode !== 'championship' || !state.championship) return;
  const champ = state.championship;
  if (upcomingChampionshipThrowerIds().includes(id)) champ.turnsRemainingInRound = Math.max(0, (champ.turnsRemainingInRound || 0) - 1);
  dropExact50(id);
}

function dropExact50(id) {
  const champ = state.championship;
  if (!champ?.exact50ThisRound?.includes(id)) return;
  champ.exact50ThisRound = champ.exact50ThisRound.filter(x => x !== id);
  if (!champ.exact50ThisRound.length && championshipFinishingRound()) {
    champ.phase = champ.phase === 'overtime-finish-round' ? 'overtime' : 'normal';
    champ.turnsRemainingInRound = 0;
  }
}

function resolveChampionshipRoundIfDone() {
  const champ = state.championship;
  if (state.mode !== 'championship' || !champ) return false;
  if ((champ.phase === 'finish-round' || champ.phase === 'overtime-finish-round') && champ.turnsRemainingInRound === 0) {
    const contenders = (champ.exact50ThisRound || []).map(id => state.players.find(p => p.id === id)).filter(p => p && !p.eliminated);
    if (contenders.length === 1) {
      state.status = 'finished';
      state.winnerId = contenders[0].id;
      state.winnerType = 'player';
      champ.phase = 'complete';
      champ.overallWinnerId = contenders[0].id;
      archiveFinishedGame();
      return true;
    }
    if (contenders.length > 1) {
      const contenderIds = new Set(contenders.map(p => p.id));
      for (const p of state.players) {
        if (contenderIds.has(p.id)) {
          p.score = state.bustScore;
          p.misses = 0;
          p.eliminated = false;
        } else {
          p.eliminated = true;
          p.overtimeExcluded = true;
        }
      }
      champ.phase = 'overtime';
      champ.overtimeRounds = (champ.overtimeRounds || 0) + 1;
      champ.exact50ThisRound = [];
      champ.turnsRemainingInRound = 0;
      state.currentPlayerIndex = state.players.findIndex(p => p.id === contenders[0].id);
      return true;
    }
  }
  return false;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

app.get('/api/state', (req, res) => apiResponse(res));
app.get('/api/history', (req, res) => res.json(history));
app.get('/api/championships', (req, res) => res.json({ championships: history.championships || [], dynasty: championshipDynasty() }));

app.post('/api/new-game', (req, res) => {
  const mode = ['individual', 'team', 'tournament', 'championship'].includes(req.body?.mode) ? req.body.mode : 'individual';
  state = defaultState();
  state.status = 'playing';
  state.mode = mode;
  state.settings.unlimitedMisses = !!req.body?.unlimitedMisses;

  if (mode === 'individual') {
    const names = uniqueClean(req.body?.players);
    if (names.length < 2) return res.status(400).json({ error: 'Add at least two players.' });
    state.players = names.map(name => ({ id: nanoid(10), name, score: 0, misses: 0, eliminated: false, throws: 0, busts: 0, totalPointsScored: 0 }));
  } else if (mode === 'championship') {
    const incoming = Array.isArray(req.body?.players) ? req.body.players : [];
    const seen = new Set();
    state.players = incoming.map((p, index) => {
      const name = normalizeName(p.name || p.player || p);
      if (!name || seen.has(canonicalName(name))) return null;
      seen.add(canonicalName(name));
      const age = Number.isFinite(Number(p.age)) ? Number(p.age) : 15;
      const bracket = getAgeBracket(age);
      return {
        id: nanoid(10),
        name,
        age,
        category: bracket.id,
        categoryLabel: bracket.label,
        categoryRange: bracket.range,
        closerLine: bracket.closerLine,
        missEliminates: bracket.missEliminates,
        score: 0,
        misses: 0,
        eliminated: false,
        manuallyExcluded: false,
        throws: 0,
        busts: 0,
        totalPointsScored: 0,
        order: index
      };
    }).filter(Boolean);
    if (state.players.length < 2) return res.status(400).json({ error: 'Add at least two championship players.' });
    state.championship = {
      id: nanoid(10),
      name: normalizeName(req.body?.championshipName) || 'Yearly Championship',
      year: Number(req.body?.championshipYear) || new Date().getFullYear(),
      phase: 'normal',
      exact50ThisRound: [],
      turnsRemainingInRound: 0,
      overtimeRounds: 0,
      ageBrackets: AGE_BRACKETS
    };
  } else {
    const incoming = Array.isArray(req.body?.teams) ? req.body.teams : [];
    const teams = incoming.map((team, index) => {
      const players = uniqueClean(team.players || []);
      return {
        id: nanoid(10),
        name: normalizeName(team.name) || `Team ${index + 1}`,
        players: players.length ? players : [normalizeName(team.name) || `Team ${index + 1}`],
        throwerIndex: 0,
        score: 0,
        misses: 0,
        eliminated: false,
        throws: 0,
        busts: 0,
        totalPointsScored: 0,
        roundsWon: 0
      };
    }).filter(t => t.name && t.players.length);
    if (teams.length < 2) return res.status(400).json({ error: 'Add at least two teams.' });
    state.teams = teams;
    state.tournament = {
      id: nanoid(10),
      name: normalizeName(req.body?.tournamentName) || 'Backyard World Championship',
      roundNumber: 1,
      targetRounds: Number(req.body?.targetRounds) || 3,
      bracketType: req.body?.bracketType || 'round-robin-ish'
    };
  }

  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/throw', (req, res) => {
  if (state.status !== 'playing') return res.status(400).json({ error: 'No active game.' });
  const { team, player } = getCurrentEntity();
  const entity = (state.mode === 'team' || state.mode === 'tournament') ? team : player;
  if (!entity || entity.eliminated) return res.status(400).json({ error: 'No current active participant.' });

  snapshotForUndo();
  const { points, pinsKnocked } = calculatePoints(req.body?.pinsKnocked || []);
  const wasMiss = points === 0;
  const previousScore = entity.score;
  let newScore = entity.score;
  let misses = entity.misses;
  let eliminated = entity.eliminated;
  let wasBust = false;
  let won = false;

  if (wasMiss) {
    misses += 1;
    if (!missesUnlimited(entity) && misses >= state.maxMisses) eliminated = true;
  } else {
    misses = 0;
    const attempted = entity.score + points;
    if (attempted > state.targetScore) { newScore = state.bustScore; wasBust = true; }
    else { newScore = attempted; won = newScore === state.targetScore; }
  }

  Object.assign(entity, {
    score: newScore,
    misses,
    eliminated,
    throws: (entity.throws || 0) + 1,
    busts: (entity.busts || 0) + (wasBust ? 1 : 0),
    totalPointsScored: (entity.totalPointsScored || 0) + points
  });

  if ((state.mode === 'team' || state.mode === 'tournament') && entity.players?.length) entity.throwerIndex = (entity.throwerIndex + 1) % entity.players.length;

  const throwRecord = {
    id: nanoid(12),
    at: now(),
    mode: state.mode,
    entityId: entity.id,
    entityName: entity.name,
    playerId: (state.mode === 'team' || state.mode === 'tournament') ? `${entity.id}:${player?.name}` : entity.id,
    playerName: (state.mode === 'team' || state.mode === 'tournament') ? player?.name : entity.name,
    age: entity.age ?? null,
    category: entity.category || null,
    categoryLabel: entity.categoryLabel || null,
    teamId: team?.id || null,
    teamName: team?.name || null,
    pinsKnocked,
    points,
    previousScore,
    newScore,
    wasBust,
    wasMiss,
    eliminated,
    turnIndex: (state.mode === 'team' || state.mode === 'tournament') ? state.currentTeamIndex : state.currentPlayerIndex
  };
  state.throwHistory.push(throwRecord);
  state.eventLog.push({ id: nanoid(10), at: throwRecord.at, message: `${throwRecord.playerName}${team ? ` for ${team.name}` : ''} scored ${points}${wasBust ? ' and busted to 25' : ''}${eliminated ? ' and was eliminated' : ''}.` });

  let handledByChampionship = false;
  if (state.mode === 'championship') handledByChampionship = maybeFinishChampionshipRound(entity, won);

  if (!handledByChampionship && state.mode !== 'championship' && won) {
    state.status = 'finished';
    state.winnerId = entity.id;
    state.winnerType = state.mode === 'individual' ? 'player' : 'team';
    if (state.mode === 'team' || state.mode === 'tournament') entity.roundsWon = (entity.roundsWon || 0) + 1;
    archiveFinishedGame();
  } else if (!handledByChampionship) {
    if (!finishIfOneLeft()) advanceTurn();
  }

  saveState();
  emitState(io);
  return apiResponse(res);
});

function finishIfOneLeft() {
  if (state.status !== 'playing') return false;
  const active = isTeamMode() ? activeTeams() : activePlayers();
  if (active.length > 1) return false;
  const survivor = active[0];
  state.status = 'finished';
  state.winnerId = survivor?.id || null;
  state.winnerType = isTeamMode() ? 'team' : 'player';
  if (survivor && isTeamMode()) survivor.roundsWon = (survivor.roundsWon || 0) + 1;
  if (state.mode === 'championship' && survivor && state.championship && !state.championship.overallWinnerId) state.championship.overallWinnerId = survivor.id;
  archiveFinishedGame();
  return true;
}

function commit(res) {
  saveState();
  emitState(io);
  return apiResponse(res);
}

function requirePlaying(res) {
  if (state.status === 'playing') return true;
  res.status(400).json({ error: 'No active game.' });
  return false;
}

function makePlayer(name, extra = {}) {
  return { id: nanoid(10), name, score: 0, misses: 0, eliminated: false, throws: 0, busts: 0, totalPointsScored: 0, ...extra };
}

function makeChampionshipPlayer(name, rawAge, order) {
  const age = rawAge !== '' && rawAge != null && Number.isFinite(Number(rawAge)) ? Number(rawAge) : 15;
  const bracket = getAgeBracket(age);
  return makePlayer(name, {
    age,
    category: bracket.id,
    categoryLabel: bracket.label,
    categoryRange: bracket.range,
    closerLine: bracket.closerLine,
    missEliminates: bracket.missEliminates,
    manuallyExcluded: false,
    order
  });
}

function makeTeam(name, players) {
  return { id: nanoid(10), name, players, throwerIndex: 0, score: 0, misses: 0, eliminated: false, throws: 0, busts: 0, totalPointsScored: 0, roundsWon: 0 };
}

// Add a player (individual/championship) or a team (team/tournament) mid-game.
app.post('/api/participants', (req, res) => {
  if (!requirePlaying(res)) return;
  const name = normalizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Enter a name.' });
  const rows = participantRows();
  if (rows.some(p => canonicalName(p.name) === canonicalName(name))) return res.status(400).json({ error: `${name} is already in this game.` });
  if (state.mode === 'championship' && state.championship?.phase !== 'normal') {
    return res.status(400).json({ error: 'Players can only join a championship before anyone hits exact 50. Wait for the round/overtime to finish.' });
  }

  snapshotForUndo();
  if (isTeamMode()) {
    const members = uniqueClean(req.body?.players || []);
    state.teams.push(makeTeam(name, members.length ? members : [name]));
    logEvent(`${name} joined the game.`);
  } else if (state.mode === 'championship') {
    const p = makeChampionshipPlayer(name, req.body?.age, state.players.length);
    state.players.push(p);
    logEvent(`${name} (${p.categoryLabel}) joined the championship.`);
  } else {
    state.players.push(makePlayer(name));
    logEvent(`${name} joined the game.`);
  }
  return commit(res);
});

// Remove a player/team from the current game entirely.
app.delete('/api/participants/:id', (req, res) => {
  if (!requirePlaying(res)) return;
  const rows = participantRows();
  const index = rows.findIndex(p => p.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Not found.' });
  const target = rows[index];
  const remainingActive = rows.filter(p => !p.eliminated && p.id !== target.id).length;
  if (remainingActive < 1 || (!target.eliminated && remainingActive < 2)) {
    return res.status(400).json({ error: `Removing ${target.name} would leave fewer than two ${isTeamMode() ? 'teams' : 'players'} in the game. Add someone first, or reset the game.` });
  }

  snapshotForUndo();
  championshipForgetPlayer(target.id);

  const key = isTeamMode() ? 'currentTeamIndex' : 'currentPlayerIndex';
  const current = state[key];
  rows.splice(index, 1);
  if (index < current) state[key] = current - 1;
  else if (index === current) state[key] = firstActiveIndexFrom(rows, index % rows.length);
  if (state.mode === 'championship' && state.championship && typeof state.championship.firstExact50Index === 'number' && index < state.championship.firstExact50Index) {
    state.championship.firstExact50Index -= 1;
  }

  logEvent(`${target.name} was removed from the game.`);
  if (!resolveChampionshipRoundIfDone()) finishIfOneLeft();
  return commit(res);
});

// Manually set a participant's score (and optionally misses).
app.post('/api/participants/:id/score', (req, res) => {
  if (!requirePlaying(res)) return;
  const entity = participantRows().find(p => p.id === req.params.id);
  if (!entity) return res.status(404).json({ error: 'Not found.' });
  const score = Number(req.body?.score);
  if (!Number.isInteger(score) || score < 0 || score >= state.targetScore) {
    return res.status(400).json({ error: `Score must be a whole number from 0 to ${state.targetScore - 1}. Record a throw to finish on ${state.targetScore}.` });
  }
  let misses = entity.misses || 0;
  if (req.body?.misses !== undefined && req.body?.misses !== '') {
    misses = Number(req.body.misses);
    if (!Number.isInteger(misses) || misses < 0) return res.status(400).json({ error: 'Misses must be a whole number of 0 or more.' });
  }

  snapshotForUndo();
  const before = entity.score;
  const wasMissElim = eliminatedByMisses(entity);
  entity.score = score;
  entity.misses = misses;
  // Lowering misses below the limit revives a player who was knocked out by misses.
  if (wasMissElim && misses < state.maxMisses && !(state.mode === 'championship' && state.championship?.phase !== 'normal')) entity.eliminated = false;
  if (state.mode === 'championship') dropExact50(entity.id);
  logEvent(`Score corrected: ${entity.name} ${before} → ${score}${req.body?.misses !== undefined ? ` (misses ${misses})` : ''}.`);
  resolveChampionshipRoundIfDone();
  return commit(res);
});

// Toggle unlimited misses for one participant.
app.post('/api/participants/:id/unlimited-misses', (req, res) => {
  if (!requirePlaying(res)) return;
  const entity = participantRows().find(p => p.id === req.params.id);
  if (!entity) return res.status(404).json({ error: 'Not found.' });
  snapshotForUndo();
  const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : entity.missEliminates !== false;
  entity.missEliminates = !enabled;
  if (enabled) revivePlayersEliminatedByMisses([entity]);
  logEvent(`${entity.name}: unlimited misses ${enabled ? 'on' : 'off'}.`);
  return commit(res);
});

// Toggle unlimited misses for everyone in the game.
app.post('/api/unlimited-misses', (req, res) => {
  snapshotForUndo();
  const enabled = !!req.body?.enabled;
  state.settings = { ...state.settings, unlimitedMisses: enabled };
  if (enabled && state.status === 'playing') revivePlayersEliminatedByMisses(participantRows());
  logEvent(`Unlimited misses for everyone ${enabled ? 'on' : 'off'}.`);
  return commit(res);
});

function revivePlayersEliminatedByMisses(rows) {
  // Reviving mid finish-the-round would add an unexpected thrower, so wait for normal play.
  if (state.mode === 'championship' && state.championship?.phase !== 'normal') return;
  for (const p of rows) if (eliminatedByMisses(p)) p.eliminated = false;
}

// Add a thrower to an existing team.
app.post('/api/teams/:id/members', (req, res) => {
  if (!requirePlaying(res)) return;
  if (!isTeamMode()) return res.status(400).json({ error: 'Not a team game.' });
  const team = state.teams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const name = normalizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Enter a name.' });
  if (team.players.some(n => canonicalName(n) === canonicalName(name))) return res.status(400).json({ error: `${name} is already on ${team.name}.` });
  snapshotForUndo();
  team.players.push(name);
  logEvent(`${name} joined ${team.name}.`);
  return commit(res);
});

// Remove a thrower from a team's rotation.
app.delete('/api/teams/:id/members/:index', (req, res) => {
  if (!requirePlaying(res)) return;
  if (!isTeamMode()) return res.status(400).json({ error: 'Not a team game.' });
  const team = state.teams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= team.players.length) return res.status(404).json({ error: 'Team member not found.' });
  if (team.players.length <= 1) return res.status(400).json({ error: `${team.name} needs at least one thrower. Remove the whole team instead.` });
  snapshotForUndo();
  const thrower = (team.throwerIndex || 0) % team.players.length;
  const [removed] = team.players.splice(index, 1);
  team.throwerIndex = (index < thrower ? thrower - 1 : thrower) % team.players.length;
  logEvent(`${removed} left ${team.name}.`);
  return commit(res);
});

app.post('/api/player/:id/exclude', (req, res) => {
  const player = state.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  snapshotForUndo();
  championshipForgetPlayer(player.id);
  player.eliminated = true;
  player.manuallyExcluded = true;
  player.excludedReason = normalizeName(req.body?.reason) || 'Manual exclude';
  if (state.currentPlayerIndex >= 0 && state.players[state.currentPlayerIndex]?.id === player.id) advanceTurn();
  if (resolveChampionshipRoundIfDone()) {
    // round resolved by removing the last pending thrower
  } else if (state.status === 'playing' && state.mode === 'championship' && activePlayers().length <= 1) {
    const survivor = activePlayers()[0];
    state.status = 'finished';
    state.winnerId = survivor?.id || null;
    state.winnerType = 'player';
    if (state.championship) state.championship.overallWinnerId = survivor?.id || null;
    archiveFinishedGame();
  }
  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/next-round', (req, res) => {
  if (!(state.mode === 'team' || state.mode === 'tournament') || !state.tournament) return res.status(400).json({ error: 'No team/tournament game is active.' });
  const teams = state.teams.map(t => ({ ...t, score: 0, misses: 0, eliminated: false, throws: 0, busts: 0, totalPointsScored: 0, throwerIndex: t.throwerIndex || 0 }));
  const tournament = { ...state.tournament, roundNumber: (state.tournament.roundNumber || 1) + 1 };
  state = { ...defaultState(), mode: 'tournament', status: 'playing', teams, tournament, settings: { ...defaultState().settings, ...state.settings } };
  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/undo', (req, res) => {
  const last = state.undoStack.pop();
  if (!last) return res.status(400).json({ error: 'Nothing to undo.' });
  state = { ...last, undoStack: state.undoStack };
  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/settings', (req, res) => {
  state.settings = { ...state.settings, ...(req.body || {}) };
  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/reset', (req, res) => {
  state = defaultState();
  saveState();
  emitState(io);
  return apiResponse(res);
});

app.post('/api/history/clear', (req, res) => {
  history = defaultHistory();
  saveHistory();
  emitState(io);
  return res.json(history);
});

const distPath = path.join(ROOT, 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

io.on('connection', socket => {
  socket.emit('state', { state, stats: buildStats(), history });
});

server.listen(PORT, () => console.log(`Mölkky scoreboard server running on http://localhost:${PORT}`));
