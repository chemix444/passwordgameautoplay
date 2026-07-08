# Password Game Autoplay

A Tampermonkey userscript that plays [neal.fun's The Password Game](https://neal.fun/password-game/)
by itself — from rule 1 through the win screen — on a live instance where the
CAPTCHA, country, chess puzzle, color, video duration, Wordle answer, and moon
phase differ every run.

> ⚠️ This is a toy built for fun and for studying DOM automation against a
> reactive rich-text editor. neal.fun ships updates; if the game's DOM
> changes, expect breakage (see [Troubleshooting](#troubleshooting)).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey) in a
   Chromium-based browser. Chrome/Edge/Brave recommended — the script relies on
   `Intl.Segmenter`, the `DataTransfer` constructor, and synthetic
   `ClipboardEvent`s, which are best supported there.
2. Install the script: open the raw file
   [`password-game-autoplay.user.js`](https://raw.githubusercontent.com/chemix444/passwordgameautoplay/claude/password-game-autosolver-fqx5bm/password-game-autoplay.user.js)
   and Tampermonkey will offer to install it.
3. Visit <https://neal.fun/password-game/>. A small HUD appears top-right and
   the run starts immediately.

**Keep the tab focused and visible.** Browsers throttle timers in background
tabs to ≥1s, which is survivable for most rules but dangerous during the fire
rule and Paul feeding.

## What it does

- **Segment-tagged password model.** The password is never edited as a raw
  string. Each rule owns a named segment (`egg`, `roman`, `wordle`, `video`,
  `digits`, …); the full password is re-rendered from the model and committed
  wholesale every cycle. If the game mutates the field (🔥 spreading, Paul
  eating a 🐛), the next commit repairs it. Segments are joined with `.` so
  element symbols and probe candidates can't bleed across boundaries.
- **No hardcoded rule numbers or texts.** A MutationObserver plus a per-tick
  scan reads every `.rule` element, parses its number and description, and
  dispatches to handlers matched by regex on the rule text. Unknown rules fall
  back to probing any emoji/quoted tokens found in the rule's own text, and
  every failing rule in the HUD is clickable for a manual text override.
- **Feedback-driven probing instead of guessing.** Facts the game randomizes or
  that depend on ambiguous conventions (country, moon-phase emoji, sponsor
  capitalization, affirmation wording, time format, chess answer index) are
  resolved by committing candidates — in batches, narrowed by binary search —
  and polling that one rule's pass/fail class. A computed moon phase and the
  local time format are tried first, so probing usually locks on attempt one.
- **Native-editor commits.** For the game's contenteditable (ProseMirror)
  field, content is committed as a synthetic paste (`ClipboardEvent` with
  `text/html` + `text/plain`), which carries the bold/italic/font-family/
  font-size formatting the late rules need. If the editor doesn't consume the
  paste, the script escalates through `beforeinput (insertFromPaste)` →
  `execCommand('insertHTML')` → `execCommand('insertText')`. Plain
  `<input>`/`<textarea>` fields are set through the native value setter with
  dispatched `input`/`change` events, since frameworks track the native setter.
- **Two independent loops.** The solve loop (250ms; 110ms while on fire) and
  the Paul feeder (1s heartbeat, 20s top-up cadence) run on separate timers,
  so a stuck rule can never starve Paul. The model holds a constant two 🐛;
  every repair commit re-tops what Paul has eaten (~3/min, matching the rule).

### Rule-specific strategies

| Rule | Strategy |
| --- | --- |
| Length / number / uppercase / special | Permanent `A!` base segment + filler floor; deletions can't drop below minimums. |
| Digits sum to 25 | Balancer segment recomputed from *all* digits in the model every cycle (leap year, chess rank, hex color, video id, time, length number all feed in). If fixed digits overshoot 25, the HUD shows a conflict and waits — a minute rollover usually resolves it. |
| Month | Probed, `may` first. |
| Roman numerals ×35 | Single numeral `XXXV` (product = 35 on its own). Uppercase `IVXLCDM` are then treated as reserved: element pool, captcha, video ids, and chess candidates are all filtered against them. Lowercase is safe — the game only reads uppercase runs. |
| Sponsors / affirmation | Probed across the known lists in both capitalizations. |
| CAPTCHA | Code scraped from the image filename; the rule's refresh button is clicked until the code has no digits and no Roman letters (bounded attempts). |
| Wordle | Fetched from the game's own API (`/api/password-game/wordle?date=…`) — the same endpoint the game queries, so it can't disagree. NYT is a fallback. |
| Moon phase | Computed locally (synodic approximation), then verified; on mismatch all 8+2 phase emojis are probed. |
| Country | The Street-View iframe isn't scraped — ~190 lowercase country names are probed in batches of 16 with binary-search narrowing (≈8 commits per hit). |
| Leap year | `2000` (digit-sum cost of only 2). |
| Chess | Board images are static assets (`chess/puzzleN.svg`) and the SAN answer list ships inside the site's own JS bundle; the script fetches the same-origin bundles, extracts the solutions array, and probes `n−1`/`n`/`n+1` to absorb indexing off-by-one. No engine needed, and it tracks site data updates automatically. |
| Paul 🥚→🐔 | Egg sits at the very front of the password (fire reaches him last). On hatch the segment flips to 🐔 and is never dropped — deleting the chick is instant death. |
| Fire | The model never contains 🔥, so every commit extinguishes; the loop tightens to 110ms while the rule is failing. |
| Atomic sum 200 | Coin-change DP over a curated element pool: no uppercase Roman letters, and no symbol whose first letter is itself an element, so greedy and overlapping scanners agree on the sum. Recomputed whenever any other segment changes. |
| Bold vowels / 2× italic / Wingdings % / Times New Roman / 50px digits / per-letter sizes | All expressed as per-grapheme marks in the rendered HTML. Italic extras are ASCII-only so the 2:1 ratio holds under any character-counting scheme; Wingdings gets a margin above the required percentage. |
| Sacrifice | Picks two letters absent from the current password, preferring `j q z w …` and never `a–f` (reserved for the hex color); clicks the tiles and confirm button, then bans those letters from every future candidate pool. |
| Hex color | Swatch read from the rule's inline background style; refreshed until the hex is digit-cheap. |
| YouTube exact duration | Searches "N minute M second timer"-style queries through public Piped/Invidious instances (they expose durations in seconds, no key needed), optionally the YouTube Data API v3 if you set `CONFIG.YT_API_KEY`, plus a local `YT_FALLBACK_POOL` you can extend. Candidates are filtered for Roman letters/banned letters/digit cost and probed with a 9s async-validation window each. |
| Password length + prime | The game's own displayed length counter is used to calibrate emoji-counting differences; the solver then searches for the smallest prime target consistent with its own digits appearing in the password, padding with `-` filler. |
| Final retype | Clicks through the confirmation and lets the normal commit loop repopulate the emptied box. |

### Failure handling

- **Checkpointing:** the full segment model is snapshotted every time all
  visible rules pass; if the run wedges for >90s with no probe in flight, it
  rolls back and re-derives.
- **Paul death / game over:** watched by both the main loop and an independent
  safety timer; the page reloads and the run restarts from rule 1
  automatically.
- **HUD:** live rule progress, current action, Paul feed countdown, digit
  budget conflicts, last error — plus Pause/Restart buttons, and click any
  failing rule to type a manual override for it.

## Configuration

Everything tunable sits in the `CONFIG` object at the top of the script
(tick rates, feed cadence, probe timeouts, YouTube API key). `YT_FALLBACK_POOL`
maps a duration in seconds to known video ids, e.g.:

```js
const YT_FALLBACK_POOL = {
  653: ['dQw4w9WgXcQ'], // 10:53 — example only, use ids you've verified
};
```

## Troubleshooting

- **"editor rejected content"** in the HUD: the paste path was refused and the
  script is rotating commit strategies. If formatting rules (bold/italic/fonts)
  won't pass on the last-resort plain-text strategy, the site's editor likely
  changed — file an issue with the DOM of `.password-box`.
- **YouTube rule stuck:** public Piped/Invidious instances rotate and die.
  Add working instances to the lists in `searchYoutube()`, set a Data API key,
  extend `YT_FALLBACK_POOL`, or click the rule in the HUD and paste a known
  URL manually.
- **Chess rule stuck:** the solutions array wasn't found in the site bundle
  (minifier output changed). Click the rule in the HUD and type the move
  (e.g. `Qh7#`) — everything else continues unattended.
- **Digit budget conflict:** some minutes of the day (e.g. 19:59) push the
  fixed digit sum past 25; the script waits for the minute to roll over.

## Development

Plain single-file userscript, no build step. `node --check
password-game-autoplay.user.js` for syntax; install in Tampermonkey and use
`window.PGAP` (state, segments, start/stop) in DevTools for live debugging.

## Disclaimer

Not affiliated with neal.fun. Be kind to the third-party APIs the script can
touch (Piped/Invidious instances); it queries them at most a handful of times
per run.

## License

[MIT](LICENSE)
