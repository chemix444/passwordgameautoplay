// End-to-end check of the userscript against a local mock of the game's DOM.
//
// The mock (mock-game.html) reproduces the parts of neal.fun's Password Game
// that the solver depends on — a ProseMirror-style contenteditable, rules that
// progressively unlock and toggle rule-error/rule-success, a refreshable
// captcha, a two-box final retype, and pre-rendered-but-hidden win/lose
// screens — so we can verify the solver drives a real browser to a win without
// touching the live site.
//
// Usage:  node test/run.js  [path-to-chromium]
// Requires: `npm i playwright` (or a preinstalled Chromium; pass its path).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.argv[2] || process.env.CHROMIUM_PATH || undefined;
const SCRIPT = path.resolve(__dirname, '..', 'password-game-autoplay.user.js');
const MOCK = 'file://' + path.resolve(__dirname, 'mock-game.html');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(MOCK, { waitUntil: 'domcontentloaded' });

  // The win screen is pre-rendered (hidden). Confirm we are not "won" yet.
  const before = await page.evaluate(() => window.__STATE__);
  assert(!before.won, 'mock should not start in a won state');

  // Stub the @grant'd network helper: canned responses for the YouTube rule's
  // sources (duration map + search page), errors for everything else so
  // offline rules degrade gracefully. The map entry carries the real-world
  // "<id><element padding>" shape, and the search result is a roman-lettered id
  // the solver must reject (X would break the roman-product rule).
  await page.addScriptTag({ content: `
    window.GM_xmlhttpRequest = function (o) {
      const ok = (text) => setTimeout(() => o.onload && o.onload({ status: 200, responseText: text }), 30);
      if (/greasyfork/.test(o.url)) {
        ok('var y0={"4:11":"zzzzzzzzzzzZr","4:12":"wivuhAAxlecTsBa"};');
      } else if (/youtube\\.com\\/results/.test(o.url)) {
        ok('"videoRenderer":{"videoId":"hXFE4Rxa52o","thumb":{},"lengthText":{"accessibility":{"accessibilityData":{"label":"4 minutes, 12 seconds"}},"simpleText":"4:12"}}');
      } else {
        setTimeout(() => o.onerror && o.onerror(new Error('blocked')), 10);
      }
    };` });
  await page.addScriptTag({ content: fs.readFileSync(SCRIPT, 'utf8') });

  // Regression guard for the original bug: no instant false win.
  await page.waitForTimeout(1200);
  const early = await page.evaluate(() => window.PGAP.state.won);
  assert(!early, 'solver must NOT report a win from the hidden pre-rendered win screen');

  // Let it solve.
  let final = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(500);
    final = await page.evaluate(() => ({ won: window.__STATE__.won, unlocked: window.__STATE__.unlocked }));
    if (final.won) break;
  }
  assert(final && final.won, 'solver should drive the mock to a win (got ' + JSON.stringify(final) + ')');

  console.log('PASS — solved all', final.unlocked, 'rules with no false win.');
  await browser.close();
})().catch((e) => { console.error('FAIL —', e.message); process.exit(1); });

function assert(cond, msg) { if (!cond) throw new Error(msg); }
