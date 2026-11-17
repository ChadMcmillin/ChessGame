# Gridiron Edge

A mobile web app that continuously scans NFL games — before kickoff and live — and surfaces the
best-value bets against DraftKings lines: spreads, totals, moneylines, team totals and player props.

## What it does

- **Best Bets** – every market is re-evaluated on each refresh (10 s while games are live, 30 s
  otherwise) and ranked by expected value. Each card shows the DraftKings price, the model's win
  chance, the break-even chance the price needs, the edge, and a suggested stake.
- **Games** – live scores, possession, down and distance, and current DraftKings lines.
- **Game tracker** – field position graphic, last play, live win probability and its chart,
  drive-by-drive log, the full prop board, injuries, line movement and team stats.
- **Money movement** – per game, how far the DraftKings line has moved since it opened and every
  change logged while the app is open. DraftKings does not publish dollars wagered, so line
  movement is used as the footprint of where the money went.
- **Parlay builder** – inside any game, choose how many legs (2–8) and Safer or Value; it picks
  the legs from that game only, shows the chance to hit and the fair price, and lets you swap legs.
- **My Bets** – track any suggestion; it is followed live and graded when the game ends.

## Run it

It is a static site with no build step and no API keys.

```
npm start        # serves on http://localhost:8080
npm test         # model unit tests
```

To use it on a phone, host the folder anywhere static (for example GitHub Pages: Settings → Pages →
Deploy from a branch → `/ (root)`), open the URL, and choose "Add to Home Screen".

## Data

Everything comes from ESPN's public NFL feed, called directly from the browser. That feed carries
DraftKings as its odds provider:

| Data | Source |
| --- | --- |
| Scores, clock, possession, spread / total / moneyline with DraftKings prices | scoreboard |
| DraftKings in-game spread / total / moneyline (the scoreboard drops odds at kickoff) | core odds, "Live Odds" provider |
| Drives, plays, box score, win probability, injuries | game summary |
| DraftKings prop lines (player and team) | odds `propBets` |
| Player game logs, rosters | athlete and team endpoints |

Known limits of the feed:

- **Prop prices are not in the free feed**, only the lines, and the app never invents one. Without
  live prices turned on (below), a prop shows the model's chance, its fair price and a "bet at X
  or better" threshold; tap it and enter the price DraftKings is showing to get a real edge.
  Spread, total and moneyline prices do come from the feed and are graded automatically.
- Lines can trail the DraftKings app by a short delay. Live suggestions are dropped when the line
  looks stale (far from what the scoreboard implies, or a prop line not refreshed in 10 minutes).

## Live DraftKings prop prices (optional)

DraftKings does not offer a public price feed and blocks automated access to its own site, so
real prop prices come from [The Odds API](https://the-odds-api.com), a licensed odds service that
carries DraftKings' player-prop lines and prices, updated about once a minute before and during
games.

1. Get an API key from the-odds-api.com.
2. In the app, tap the settings icon (top right), paste the key, and tap **Save and connect**.

From then on DraftKings' lines and prices replace the free feed's lines for every covered market
(passing, rushing, receiving, anytime touchdown and more), and props are graded automatically.

The service bills in credits: one credit per market per game per check. Settings lets you choose
which markets, how often, and which games, shows an estimate, and shows credits remaining. Checks
only run while the app is on screen, and stop when credits run out. The service's free key includes
500 credits a month; with **Only when I tap** selected nothing is spent until you press "Get
DraftKings prices" on a game, which makes the free key last about 50 checks. The key is stored only on the
device (`js/odds.js` sends it to the odds service and nowhere else).

## The model (`js/model.js`)

- **Team ratings** – offense and defense rated separately from every final score this season,
  adjusted for opponent and home field, regressed toward average for small samples.
- **Pregame** – the model's number is pulled 70% of the way toward the market before computing
  cover probability, so only real disagreements survive the vig.
- **Live** – projected final margin and total are recomputed from score, clock, possession and
  field position, anchored to the closing pregame line, and blended with ESPN's win probability.
- **Props** – recency-weighted projection from the player's game logs (low whole-number lines such
  as 0.5 receptions are counted out exactly rather than approximated); live, it adds what the
  player already has to a pace-adjusted remainder. Once a real price is entered, the model's
  probability is pulled halfway toward the market's own before the edge is computed. Players
  whose line is far from their season form are flagged "role changed?" and not bet.
- **Grades** – A ≥ 6% expected value, B ≥ 3%, C ≥ 1%. Stakes are quarter-Kelly, capped at 2 units.

These are estimates from a simple public-data model, not guarantees. Bet responsibly; 21+.
Problem gambling help: 1-800-GAMBLER.
