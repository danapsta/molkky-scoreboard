# Mölkky Scoreboard v2

Adds richer rotating stats, persistent history, team mode, and basic tournament rounds.

## Run

```bash
npm install
npm run dev
```

Admin: http://localhost:5173
Display: http://localhost:5173/display

## New features

- More rotating stats:
  - favorite number
  - average throw
  - biggest throw
  - clutch zone
  - bust magnet
  - danger players/teams
  - next team throwers
  - recent winners from history
- Team mode:
  - Teams have shared scores
  - Team members rotate throwers every time that team throws
- Tournament mode:
  - Tracks tournament name
  - Tracks round number
  - Tracks team round wins
  - Adds a Next Round button after a team/tournament round finishes
- Persistent history:
  - Finished games are archived to `data/history.json`
  - History panel appears in the admin dashboard

## Important upgrade note

If you have an old corrupted state file from the previous recursive-history bug, the new server tries to sanitize it. If the app still hangs, delete the current state file:

```bash
rm -f data/game-state.json
```

Do not delete `data/history.json` unless you want to wipe the archive.

## Championship mode

Championship mode is a custom yearly format. Enter players as `Name, Age`. The app assigns age brackets automatically:

- Toddler 0-4: closer line, misses do not auto-eliminate.
- Children 5-9: closer line, misses do not auto-eliminate.
- Pre-Teen 10-14: official line, normal miss elimination.
- Adult 15-60: official rules.
- Senior 60+: official rules, separate category.

Championship end-game behavior:

1. The first exact 50 does not immediately end the game.
2. The app finishes the current round so later players can also hit exact 50.
3. If exactly one player hit 50, that player is the overall champion.
4. If multiple players hit 50 in the same round, only those players continue in overtime.
5. Overtime players reset to 25 and repeat the same finish-the-round rule until one overall champion remains.
6. Category winners are recorded at the end and stored in `data/history.json` under `championships`.

The dashboard shows last championship winners and dynasty stats based on matching player names over multiple years.
