# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Wangzinan62/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Wangzinan62/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for make.fun's token-radar-01 bounty. `main.ts` (Node 22, standard
library only) reads the sealed DefiLlama snapshot, scores every pre-token
protocol with a comparables model derived from the snapshot itself, and writes
a ranked board (`board.json`), a static dashboard (`dashboard/` plus the
generated `data.js`), screenshots and the judge's `dossier.json` into the
output directory.

Run it:

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

The model, in one line: a pre-token protocol's implied value is its TVL times
the market-cap/TVL multiple that already-tokenized protocols in its own
category actually trade at (median, shrunk toward the global median), adjusted
for 7-day TVL momentum, operating maturity, and a small-size discount. No
protocol name is special-cased anywhere.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7n4st51n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
