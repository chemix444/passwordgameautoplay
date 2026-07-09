# Test harness

An end-to-end check that drives the userscript in a real (headless) Chromium
against a local mock of the game, so the core engine can be verified without
touching the live site.

- **`mock-game.html`** — a stand-in for neal.fun's Password Game reproducing the
  parts the solver depends on: a `.ProseMirror` contenteditable, rules that
  unlock progressively and toggle `rule-error`/`rule-success`, a refreshable
  `.captcha-img`, a two-box final retype, and **pre-rendered-but-hidden**
  win/lose screens (the trap that caused the original "instant win" bug).
- **`run.js`** — loads the mock, injects the userscript, and asserts that it
  (a) does **not** report a win from the hidden win screen and (b) drives the
  mock to a genuine win across all rules.

## Run

```bash
npm install                # installs playwright (dev dependency)
npx playwright install chromium   # or point at an existing browser:
node test/run.js /path/to/chromium
# or:  CHROMIUM_PATH=/path/to/chromium node test/run.js
```

Expected output:

```
PASS — solved all 20 rules with no false win.
```

## What it covers

Editor commit mechanism, dynamic rule detection, month/country/adjacent probing
with binary-search narrowing and locking, the all-moon-phases trick, captcha
refresh, the digit-sum and atomic-number balancers (including accounting for the
stray `V` in `XXXV`), bold-vowels rendering (y counts as a vowel, checked via
real `<b>` ancestry in the editor DOM — including the formatting-only-change
commit path), the spaceless affirmation matching, the YouTube exact-duration machine
(rule-text parsing, duration-map fetch with element-padding stripping, rejection
of roman-lettered ids, URL probing — network sources served canned by the GM
stub), prime-length filler, the two-box final retype, and the visibility-gated
win/death watchers.

## What it does NOT cover

The live-only rules — Wordle (game API), chess (site bundle extraction), the
real YouTube/Greasy Fork endpoints — and the Paul/fire and font-formatting
rules. Those depend on the real site (Cloudflare blocks non-interactive access)
and are best-effort against the current DOM, with the HUD's per-rule manual
override as the fallback.
