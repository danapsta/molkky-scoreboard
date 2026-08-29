import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, socket } from './socket';
import './styles.css';

const PIN_NUMBERS = Array.from({ length: 12 }, (_, i) => i + 1);
const BRACKET_ORDER = ['toddler', 'children', 'preteen', 'adult', 'senior'];
const BRACKET_LABELS = {
  toddler: 'Toddler 0-4',
  children: 'Children 5-9',
  preteen: 'Pre-Teen 10-14',
  adult: 'Adult 15-60',
  senior: 'Senior 60+'
};


function canonicalName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function championshipDynasties(history) {
  const counts = new Map();

  for (const c of history?.championships || []) {
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
      current.wins += 1;
      if (entry.wasOverall) current.overallWins += 1;
      if (entry.categories.size) current.categoryWins += 1;
      current.years.push(yearKey);
      for (const category of entry.categories) current.categories[category] = (current.categories[category] || 0) + 1;
      counts.set(key, current);
    }
  }

  return [...counts.values()].sort((a, b) => b.wins - a.wins || b.overallWins - a.overallWins || a.name.localeCompare(b.name));
}

function makeChampionshipHistoryStats(history) {
  const champs = history?.championships || [];
  if (!champs.length) return [];

  const latest = champs.at(-1);
  const dynasties = championshipDynasties(history);
  const items = [];

  if (latest?.overallWinner?.name) items.push(`Championship history: last overall winner was ${latest.overallWinner.name} (${latest.year}).`);
  for (const id of BRACKET_ORDER) {
    const winner = latest?.categoryWinners?.[id];
    if (winner?.name) items.push(`Last ${BRACKET_LABELS[id]} champion: ${winner.name} with ${winner.score}.`);
  }
  if (dynasties[0]) items.push(`Most championship years won: ${dynasties[0].name} with ${dynasties[0].wins} unique year win(s).`);
  const overallLeader = [...dynasties].sort((a, b) => b.overallWins - a.overallWins || b.wins - a.wins)[0];
  if (overallLeader?.overallWins) items.push(`Most overall titles: ${overallLeader.name} with ${overallLeader.overallWins}.`);
  items.push(`${champs.length} championship record(s) saved for future trash talk.`);

  return items;
}

function useGameState() {
  const [payload, setPayload] = useState({ state: null, stats: null, history: null });
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/state').then(setPayload).catch(err => setError(err.message));
    socket.on('state', setPayload);
    return () => socket.off('state', setPayload);
  }, []);
  return { ...payload, error, setError };
}

function DisplayName({ state, stats }) {
  if (state.mode === 'team' || state.mode === 'tournament') return `${stats.currentPlayer?.name || 'Nobody'} · ${stats.currentTeam?.name || 'No team'}`;
  return stats.currentPlayer?.name || 'Start a game';
}

function makeRotatingStats(state, stats, history) {
  const items = [];
  if (stats.closestToWin) items.push(`${stats.closestToWin.name} needs ${stats.closestToWin.needs} to win.`);
  if (stats.favoriteNumber) items.push(`Favorite number: ${stats.favoriteNumber.number}, knocked ${stats.favoriteNumber.count} times.`);
  if (stats.averageThrow > 0) items.push(`Average throw: ${stats.averageThrow.toFixed(1)} points across ${stats.totalThrows} throws.`);
  if (stats.biggestThrow) items.push(`Biggest throw: ${stats.biggestThrow.playerName} scored ${stats.biggestThrow.points}.`);
  if (stats.hotHand?.recentAverage > 0) items.push(`Hot hand: ${stats.hotHand.name}, averaging ${stats.hotHand.recentAverage.toFixed(1)} recently.`);
  if (stats.bustLeader?.busts > 0) items.push(`Bust magnet: ${stats.bustLeader.name} has busted ${stats.bustLeader.busts} time(s).`);
  if (stats.clutchPlayers?.length) items.push(`Clutch zone: ${stats.clutchPlayers.map(p => `${p.name} needs ${state.targetScore - p.score}`).join(', ')}.`);
  if (stats.dangerPlayers?.length) items.push(`Danger: ${stats.dangerPlayers.map(p => `${p.name} has ${p.misses} misses`).join(', ')}.`);
  if (stats.lastThrow) items.push(`Last throw: ${stats.lastThrow.playerName}${stats.lastThrow.teamName ? ` for ${stats.lastThrow.teamName}` : ''} scored ${stats.lastThrow.points}${stats.lastThrow.wasBust ? ' and busted to 25' : ''}.`);
  if (stats.totalPoints > 0) items.push(`Total points scored so far: ${stats.totalPoints}.`);
  if (stats.missLeader?.misses > 0) items.push(`Most misses: ${stats.missLeader.name} with ${stats.missLeader.misses}.`);
  if (stats.historySummary?.tournamentsPlayed > 0) items.push(`Tournaments completed all-time: ${stats.historySummary.tournamentsPlayed}.`);
  if (stats.historySummary?.championshipsPlayed > 0) items.push(`Championships completed all-time: ${stats.historySummary.championshipsPlayed}.`);

  if (state.mode === 'championship' && stats.championship) {
    const phase = stats.championship.phase;
    if (phase === 'finish-round') items.push(`Championship rule active: finishing the round. ${stats.championship.turnsRemainingInRound} throw(s) left before winner check.`);
    if (phase === 'overtime' || phase === 'overtime-finish-round') items.push(`Overtime sudden death: tied exact-50 players reset to 25. Everyone else can heckle politely.`);
    if (stats.championship.exact50ThisRound?.length) {
      const names = stats.championship.exact50ThisRound.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(', ');
      items.push(`Exact 50 this round: ${names}.`);
    }
    const previous = stats.championship.previous?.latest;
    if (previous?.overallWinner?.name) items.push(`Last championship overall winner: ${previous.overallWinner.name} in ${previous.year}.`);
    for (const bracket of BRACKET_ORDER) {
      const winner = stats.championship.previous?.byCategory?.[bracket];
      if (winner?.name) items.push(`Last ${BRACKET_LABELS[bracket]} winner: ${winner.name} with ${winner.score}.`);
    }
    if (stats.championship.dynasty?.length) {
      const king = stats.championship.dynasty[0];
      items.push(`Dynasty watch: ${king.name} has ${king.wins} unique championship-year win(s).`);
    }
  }

  if (state.mode !== 'individual' && state.mode !== 'championship' && state.tournament) {
    const standings = [...state.teams].sort((a, b) => (b.roundsWon || 0) - (a.roundsWon || 0));
    items.push(`${state.tournament.name}: round ${state.tournament.roundNumber}, leader ${standings[0]?.name || 'nobody'} with ${standings[0]?.roundsWon || 0} round win(s).`);
    const nextThrowers = state.teams.map(t => `${t.name}: ${t.players[t.throwerIndex % t.players.length]}`).join(' · ');
    items.push(`Next team throwers: ${nextThrowers}.`);
  }
  if (history?.games?.length) items.push(`All-time archive: ${history.games.length} game(s) logged. Recent winner: ${history.games.at(-1)?.winnerName || 'unknown'}.`);
  items.push(`${stats.activeCount} ${state.mode === 'team' || state.mode === 'tournament' ? 'teams' : 'players'} still alive.`);
  return items;
}

const TROPHIES = ['🥇', '🥈', '🥉'];
const STATS_VISIBLE_COUNT = 1;

function visibleWindow(list, startIndex, count) {
  if (!list.length) return [];
  const size = Math.min(count, list.length);
  return Array.from({ length: size }, (_, i) => list[(startIndex + i) % list.length]);
}

function DisplayView({ state, stats, history }) {
  const [statIndex, setStatIndex] = useState(0);
  const rows = state.mode === 'team' || state.mode === 'tournament' ? state.teams : state.players;
  const winner = rows.find(p => p.id === state.winnerId);
  const rotating = useMemo(() => makeRotatingStats(state, stats, history), [state, stats, history]);
  const championshipHistoryRotating = useMemo(() => makeChampionshipHistoryStats(history), [history]);
  const combinedStats = useMemo(() => [...rotating, ...championshipHistoryRotating], [rotating, championshipHistoryRotating]);

  useEffect(() => {
    const ms = Math.max(3, state.settings.rotateStatsSeconds || 8) * 1000;
    const timer = setInterval(() => setStatIndex(i => (i + 1) % Math.max(1, combinedStats.length)), ms);
    return () => clearInterval(timer);
  }, [combinedStats.length, state.settings.rotateStatsSeconds]);

  const visibleStats = useMemo(() => visibleWindow(combinedStats, statIndex, STATS_VISIBLE_COUNT), [combinedStats, statIndex]);

  return <main className="display-shell">
    <section className="hero-card">
      {state.status === 'finished' ? <>
        <div className="eyebrow">{state.mode === 'championship' ? 'Overall Champion' : 'Winner'}</div>
        <h1>{winner?.name || 'Game Over'}</h1>
        <p>{state.mode === 'championship' ? 'Category winners are logged for next year’s bragging rights.' : state.mode === 'individual' ? 'Bragging rights have been assigned.' : `Round ${state.tournament?.roundNumber || 1} goes to ${winner?.name || 'the survivor'}.`}</p>
      </> : <>
        <div className="eyebrow">Current Turn {state.mode !== 'individual' ? `· ${state.mode}` : ''}</div>
        <h1><DisplayName state={state} stats={stats} /></h1>
        {stats.currentEntity && <p>{stats.currentEntity.name} score {stats.currentEntity.score} · needs {state.targetScore - stats.currentEntity.score} · misses {stats.currentEntity.misses}/{stats.currentEntity.missEliminates === false ? '∞' : state.maxMisses}</p>}
        {state.mode === 'championship' && <p className="hint">{state.championship?.name} {state.championship?.year} · {stats.championship?.phase}</p>}
      </>}
    </section>

    <section className="leader-grid">
      {stats.topThree.map((p, index) => <div className={`leader-card rank-${index + 1}`} key={p.id}>
        <div className="rank">{TROPHIES[index] && <span className="trophy">{TROPHIES[index]}</span>}#{index + 1}</div>
        <div className="leader-name">{p.name}</div>
        <div className="leader-score">{p.score}</div>
        <div className="leader-sub">Needs {state.targetScore - p.score}{p.categoryLabel ? ` · ${p.categoryLabel}` : ''}{p.roundsWon ? ` · ${p.roundsWon} round wins` : ''}</div>
      </div>)}
    </section>

    <section className="stats-panel">
      <div className="section-title">Interesting Stats</div>
      <div className="stats-grid">
        {visibleStats.length ? visibleStats.map((text, i) => <div className="stat-tile" key={`${statIndex}-${i}`}>{text}</div>) : <div className="stat-tile">Waiting for stats...</div>}
      </div>
    </section>
  </main>;
}

function SetupPanel({ setError }) {
  const [mode, setMode] = useState('individual');
  const [names, setNames] = useState('Ben\nSarah\nMike\nTom');
  const [tournamentName, setTournamentName] = useState('Backyard World Championship');
  const [teamsText, setTeamsText] = useState('Team Biscuits: Ben, Sarah\nTeam Skittles: Mike, Tom');
  const [championshipName, setChampionshipName] = useState('Yearly Championship');
  const [championshipYear, setChampionshipYear] = useState(String(new Date().getFullYear()));
  const [championshipPlayers, setChampionshipPlayers] = useState('Ben, 39\nSarah, 36\nMaddie, 8\nLeo, 4\nNana, 67');

  function parseTeams(text) {
    return text.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
      const [rawName, rawPlayers = ''] = line.includes(':') ? line.split(':') : [`Team ${index + 1}`, line];
      return { name: rawName.trim(), players: rawPlayers.split(',').map(p => p.trim()).filter(Boolean) };
    });
  }

  function parseChampionshipPlayers(text) {
    return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [name, age = '15'] = line.split(',').map(x => x.trim());
      return { name, age: Number(age) };
    }).filter(p => p.name);
  }

  async function start() {
    try {
      if (mode === 'individual') {
        const players = names.split('\n').map(n => n.trim()).filter(Boolean);
        await api('/api/new-game', { method: 'POST', body: JSON.stringify({ mode, players }) });
      } else if (mode === 'championship') {
        await api('/api/new-game', { method: 'POST', body: JSON.stringify({ mode, championshipName, championshipYear: Number(championshipYear), players: parseChampionshipPlayers(championshipPlayers) }) });
      } else {
        await api('/api/new-game', { method: 'POST', body: JSON.stringify({ mode, tournamentName, teams: parseTeams(teamsText) }) });
      }
    } catch (err) { setError(err.message); }
  }

  return <main className="admin-shell setup-shell">
    <section className="admin-card current-card">
      <h2>New Game</h2>
      <div className="mode-tabs">
        <button className={mode === 'individual' ? 'selected' : ''} onClick={() => setMode('individual')}>Individual</button>
        <button className={mode === 'team' ? 'selected' : ''} onClick={() => setMode('team')}>Teams</button>
        <button className={mode === 'tournament' ? 'selected' : ''} onClick={() => setMode('tournament')}>Tournament</button>
        <button className={mode === 'championship' ? 'selected' : ''} onClick={() => setMode('championship')}>Championship</button>
      </div>
    </section>

    {mode === 'individual' ? <section className="admin-card">
      <h2>Players</h2>
      <p>One player per line.</p>
      <textarea value={names} onChange={e => setNames(e.target.value)} rows={8} />
      <button className="primary" onClick={start}>Start Game</button>
    </section> : mode === 'championship' ? <section className="admin-card wide-card">
      <h2>Yearly Championship</h2>
      <p className="hint">Format: <code>Name, Age</code>. Age bracket rules are assigned automatically.</p>
      <div className="form-grid">
        <label>Championship Name<textarea value={championshipName} onChange={e => setChampionshipName(e.target.value)} rows={1} /></label>
        <label>Year<textarea value={championshipYear} onChange={e => setChampionshipYear(e.target.value)} rows={1} /></label>
      </div>
      <textarea value={championshipPlayers} onChange={e => setChampionshipPlayers(e.target.value)} rows={10} />
      <p className="hint">Toddler/Children: closer line, misses do not auto-eliminate. Pre-Teen/Adult/Senior: official miss elimination. Exact-50 players finish the round; ties go to overtime from 25.</p>
      <button className="primary" onClick={start}>Start Championship</button>
    </section> : <section className="admin-card">
      <h2>{mode === 'tournament' ? 'Tournament' : 'Team Game'}</h2>
      <p className="hint">Format: Team Name: Player 1, Player 2. The app rotates throwers within each team on that team’s turns.</p>
      <textarea value={teamsText} onChange={e => setTeamsText(e.target.value)} rows={8} />
      {mode === 'tournament' && <textarea value={tournamentName} onChange={e => setTournamentName(e.target.value)} rows={1} />}
      <button className="primary" onClick={start}>Start {mode === 'tournament' ? 'Tournament' : 'Team Game'}</button>
    </section>}
  </main>;
}

function ChampionshipHistoryPanel({ history }) {
  const latest = history?.championships?.at?.(-1);
  const dynasties = championshipDynasties(history).slice(0, 5);

  return <section className="admin-card">
    <h2>Championship History</h2>
    {latest ? <>
      <p className="hint">Last championship: {latest.name} {latest.year}</p>
      <div className="compact-list">
        <div className="compact-row"><span>Overall</span><strong>{latest.overallWinner?.name || '—'}</strong><em>{latest.overallWinner?.score ?? '—'}</em></div>
        {BRACKET_ORDER.map(id => <div className="compact-row" key={id}><span>{BRACKET_LABELS[id]}</span><strong>{latest.categoryWinners?.[id]?.name || '—'}</strong><em>{latest.categoryWinners?.[id]?.score ?? '—'}</em></div>)}
      </div>
      {!!dynasties.length && <><h3>Most unique championship-year wins</h3><div className="stat-list">{dynasties.map(d => <div className="stat-pill" key={d.name}>{d.name}: {d.wins} year win(s){d.overallWins ? ` · ${d.overallWins} overall` : ''}</div>)}</div></>}
      <p className="hint">Overall + category in the same championship year only counts once in dynasty totals. No more double-dipping. Greedy little scoreboard.</p>
    </> : <p className="hint">No championship records yet. The dynasty machine awaits.</p>}
  </section>;
}

function HistoryPanel({ history }) {
  return <section className="admin-card">
    <h2>History</h2>
    <p className="hint">Persistent logs are stored in <code>data/history.json</code>.</p>
    <div className="compact-list">
      {(history?.games || []).slice(-8).reverse().map(g => <div className="compact-row" key={g.id}>
        <span>{g.winnerName || 'No winner'} <small>{g.mode}</small></span>
        <strong>{Math.max(...g.finalScores.map(s => s.score), 0)}</strong>
        <em>{new Date(g.finishedAt).toLocaleDateString()}</em>
      </div>)}
      {!history?.games?.length && <p className="hint">No finished games yet. Go create some legends.</p>}
    </div>
  </section>;
}

function ScoreView({ state, stats, setError }) {
  const [selectedPins, setSelectedPins] = useState([]);
  const current = stats.currentPlayer;
  const entity = stats.currentEntity;
  const calculated = selectedPins.length === 0 ? 0 : selectedPins.length === 1 ? selectedPins[0] : selectedPins.length;

  function togglePin(pin) { setSelectedPins(pins => pins.includes(pin) ? pins.filter(p => p !== pin) : [...pins, pin].sort((a, b) => a - b)); }
  async function submitThrow(pinsKnocked) {
    try { await api('/api/throw', { method: 'POST', body: JSON.stringify({ pinsKnocked }) }); setSelectedPins([]); }
    catch (err) { setError(err.message); }
  }
  async function undo() { try { await api('/api/undo', { method: 'POST' }); } catch (err) { setError(err.message); } }

  if (state.status === 'setup') return <SetupPanel setError={setError} />;

  if (state.status === 'finished') {
    const rows = state.mode === 'team' || state.mode === 'tournament' ? state.teams : state.players;
    const winner = rows.find(p => p.id === state.winnerId);
    return <main className="score-shell">
      <section className="score-header finished">
        <div className="eyebrow">Game Over</div>
        <h1>{winner?.name || 'No winner'}</h1>
        <p className="hint">Start a new game or next round from the main scoreboard screen.</p>
      </section>
    </main>;
  }

  return <main className="score-shell">
    <section className="score-header">
      <div className="eyebrow">{state.mode === 'team' || state.mode === 'tournament' ? 'Current Thrower' : 'Current Player'}</div>
      <h1>{state.mode === 'team' || state.mode === 'tournament' ? `${current?.name || ''} · ${stats.currentTeam?.name || ''}` : current?.name}</h1>
      {entity && <p>Score {entity.score} · needs {state.targetScore - entity.score} · misses {entity.misses}/{entity.missEliminates === false ? '∞' : state.maxMisses}</p>}
    </section>

    <div className="score-pin-grid">
      {PIN_NUMBERS.map(pin => <button key={pin} className={selectedPins.includes(pin) ? 'selected' : ''} onClick={() => togglePin(pin)}>{pin}</button>)}
    </div>

    <div className="score-actions">
      <button onClick={() => submitThrow([])} className="danger" disabled={!entity}>Miss</button>
      <button onClick={() => submitThrow(selectedPins)} className="primary" disabled={!entity}>Submit {calculated}</button>
    </div>
    <button onClick={undo} className="undo-btn">Undo Last Throw</button>
  </main>;
}

function AdminView({ state, stats, history, setError }) {
  const [selectedPins, setSelectedPins] = useState([]);
  const current = stats.currentPlayer;
  const entity = stats.currentEntity;
  const rows = state.mode === 'team' || state.mode === 'tournament' ? state.teams : state.players;
  const calculated = selectedPins.length === 0 ? 0 : selectedPins.length === 1 ? selectedPins[0] : selectedPins.length;
  const rotating = useMemo(() => makeRotatingStats(state, stats, history), [state, stats, history]);

  function togglePin(pin) { setSelectedPins(pins => pins.includes(pin) ? pins.filter(p => p !== pin) : [...pins, pin].sort((a, b) => a - b)); }
  async function submitThrow(pinsKnocked) {
    try { await api('/api/throw', { method: 'POST', body: JSON.stringify({ pinsKnocked }) }); setSelectedPins([]); }
    catch (err) { setError(err.message); }
  }
  async function undo() { try { await api('/api/undo', { method: 'POST' }); } catch (err) { setError(err.message); } }
  async function reset() { if (confirm('Reset the whole game?')) try { await api('/api/reset', { method: 'POST' }); } catch (err) { setError(err.message); } }
  async function nextRound() { try { await api('/api/next-round', { method: 'POST' }); } catch (err) { setError(err.message); } }
  async function excludePlayer(id) {
    if (!confirm('Manually exclude this player from the active game?')) return;
    try { await api(`/api/player/${id}/exclude`, { method: 'POST', body: JSON.stringify({ reason: 'Manual exclude' }) }); }
    catch (err) { setError(err.message); }
  }

  if (state.status === 'setup') return <SetupPanel setError={setError} />;

  return <main className="admin-shell">
    <section className="admin-card current-card">
      <div className="eyebrow">Current {state.mode === 'team' || state.mode === 'tournament' ? 'Thrower' : 'Player'}</div>
      <h1>{state.mode === 'team' || state.mode === 'tournament' ? `${current?.name || ''} · ${stats.currentTeam?.name || ''}` : current?.name}</h1>
      {entity && <p>{entity.name}: score {entity.score}; needs {state.targetScore - entity.score}; misses {entity.misses}/{entity.missEliminates === false ? '∞' : state.maxMisses}</p>}
      {state.mode !== 'individual' && state.mode !== 'championship' && state.tournament && <p className="hint">{state.tournament.name} · Round {state.tournament.roundNumber}</p>}
      {state.mode === 'championship' && <p className="hint">{state.championship?.name} {state.championship?.year} · {stats.championship?.phase} · {stats.championship?.turnsRemainingInRound || 0} round throw(s) pending</p>}
      <div className="admin-actions">
        <button onClick={() => submitThrow([])} className="danger" disabled={state.status === 'finished'}>Miss</button>
        <button onClick={() => submitThrow(selectedPins)} className="primary" disabled={!entity || state.status === 'finished'}>Submit {calculated} Points</button>
        <button onClick={undo}>Undo</button>
        <button onClick={reset}>Reset</button>
        {state.status === 'finished' && state.mode !== 'individual' && state.mode !== 'championship' && <button className="primary" onClick={nextRound}>Next Round</button>}
      </div>
    </section>

    <section className="admin-card">
      <h2>Knocked Pins</h2>
      <div className="pin-grid">{PIN_NUMBERS.map(pin => <button key={pin} className={selectedPins.includes(pin) ? 'selected' : ''} onClick={() => togglePin(pin)}>{pin}</button>)}</div>
      <p className="hint">One pin = that pin number. Multiple pins = count of pins. Empty/miss = 0.</p>
    </section>

    <section className="admin-card">
      <h2>Scores</h2>
      <div className="compact-list">
        {rows.map(p => <div className={`compact-row ${p.id === entity?.id ? 'active' : ''} ${p.eliminated ? 'dead' : ''}`} key={p.id}>
          <span>{p.name}{p.players && <small>Next: {p.players[p.throwerIndex % p.players.length]}</small>}{p.categoryLabel && <small>{p.categoryLabel} · age {p.age}{p.closerLine ? ' · closer line' : ''}</small>}</span>
          <strong>{p.score}</strong>
          <em>{p.eliminated ? (p.manuallyExcluded ? 'Excluded' : 'Eliminated') : `${p.misses}/${p.missEliminates === false ? '∞' : state.maxMisses} misses${p.roundsWon ? ` · ${p.roundsWon}W` : ''}`}</em>
          {state.mode === 'championship' && !p.eliminated && <button className="mini danger" onClick={() => excludePlayer(p.id)}>Exclude</button>}
        </div>)}
      </div>
    </section>

    {state.mode === 'championship' && <section className="admin-card">
      <h2>Current Category Leaders</h2>
      <div className="compact-list">
        {BRACKET_ORDER.map(id => {
          const w = stats.championship?.categoryWinnersIfEndedNow?.[id];
          return <div className="compact-row" key={id}><span>{BRACKET_LABELS[id]}</span><strong>{w?.name || '—'}</strong><em>{w ? `${w.score} pts` : 'No entries'}</em></div>;
        })}
      </div>
    </section>}

    <section className="admin-card">
      <h2>Fun Stats</h2>
      <div className="stat-list">{rotating.slice(0, 10).map((s, i) => <div className="stat-pill" key={i}>{s}</div>)}</div>
    </section>

    <section className="admin-card">
      <h2>Recent Throws</h2>
      <div className="compact-list">
        {[...state.throwHistory].slice(-8).reverse().map(t => <div className="compact-row" key={t.id}>
          <span>{t.playerName}{t.teamName && <small>{t.teamName}</small>}{t.categoryLabel && <small>{t.categoryLabel}</small>}</span><strong>{t.points}</strong><em>{t.wasBust ? 'Bust' : t.wasMiss ? 'Miss' : t.pinsKnocked.join(', ')}</em>
        </div>)}
      </div>
    </section>

    <HistoryPanel history={history} />
    <ChampionshipHistoryPanel history={history} />
  </main>;
}

function App() {
  const { state, stats, history, error, setError } = useGameState();
  const path = window.location.pathname;
  if (!state || !stats) return <div className="loading">Loading scoreboard...</div>;
  return <>
    {error && <div className="toast" onClick={() => setError('')}>{error}</div>}
    {path.startsWith('/display') ? <DisplayView state={state} stats={stats} history={history} />
      : path.startsWith('/score') ? <ScoreView state={state} stats={stats} setError={setError} />
      : <AdminView state={state} stats={stats} history={history} setError={setError} />}
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
