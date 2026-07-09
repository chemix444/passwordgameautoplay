// ==UserScript==
// @name         Password Game Autoplay
// @namespace    https://github.com/chemix444/passwordgameautoplay
// @version      1.2.0
// @description  Unattended auto-solver for neal.fun's The Password Game — rule 1 through the win screen.
// @author       chemix444
// @match        https://neal.fun/password-game/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      neal.fun
// @connect      youtube.com
// @connect      www.youtube.com
// @connect      update.greasyfork.org
// @connect      pipedapi.adminforge.de
// @connect      api.piped.private.coffee
// @connect      www.googleapis.com
// @connect      www.nytimes.com
// @license      MIT
// ==/UserScript==

/*
 * Architecture (see README for the long version):
 *  - A segment-tagged password model is the single source of truth. Every rule
 *    owns a named segment; the full password is re-rendered from the model and
 *    committed wholesale on every cycle, so anything the game mutates in-place
 *    (fire chars, eaten caterpillars) is repaired on the next commit.
 *  - Rules are never hardcoded by number-to-meaning. A MutationObserver flags
 *    DOM changes; every tick re-scans `.rule` elements, parses their number and
 *    text, and dispatches to handlers matched by regex on the rule text.
 *  - Ambiguous facts (moon phase, country, sponsor case, time format, chess
 *    answer index) are resolved by probing: commit a candidate (or a batch,
 *    binary-searched), poll that one rule's pass class, keep what sticks.
 *  - The main solve loop and the Paul feeder run as two independent timers.
 *  - Balancer segments (digit sum, atomic-number sum, prime-length filler) are
 *    recomputed from the whole model every cycle, so any rule that introduces
 *    stray digits/elements is automatically compensated.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  const CONFIG = {
    TICK_MS: 250,            // main solve cycle
    FIRE_TICK_MS: 110,       // cycle while the password is on fire
    SETTLE_TICKS: 2,         // ticks to wait after a commit before trusting rule classes
    FEED_EVERY_MS: 20000,    // Paul feeding cadence (~3/min)
    FOOD_TARGET: 2,          // caterpillars kept in the password at all times
    YT_API_KEY: '',          // optional: YouTube Data API v3 key for exact-duration search
    YT_PROBE_TIMEOUT_MS: 9000, // per-candidate wait for the game's async URL check
    CAPTCHA_MAX_REFRESH: 14,
    COLOR_MAX_REFRESH: 14,
    COLOR_DIGIT_MAX: 4,      // acceptable digit-sum in the hex color before we stop refreshing
    WINGDINGS_MARGIN: 0.06,  // overshoot on the wingdings ratio (grapheme-count ambiguity)
    MIN_FILLER: 2,
    RESTART_DELAY_MS: 1600,
    REPROBE_AFTER_FAILS: 25, // settled fails before a locked probe result is retried
  };

  // Fallback pool for the YouTube rule: seconds -> [videoId, ...]. Empty by
  // default; add your own verified entries (see README) to skip the network.
  const YT_FALLBACK_POOL = {};

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */
  const SEG = ('Segmenter' in Intl) ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  const graphemes = (s) => SEG ? Array.from(SEG.segment(s), (x) => x.segment) : Array.from(s);
  const glen = (s) => graphemes(s).length;
  const digitSum = (s) => (s.match(/[0-9]/g) || []).reduce((a, c) => a + (+c), 0);
  // The game counts y as a vowel for the bold-vowels rule ("a, e, i, o, u,
  // and sometimes y") — leaving y unbolded fails rule 19.
  const isVowel = (g) => /^[aeiouyAEIOUY]$/.test(g);
  const isAsciiNonVowel = (g) => /^[\x21-\x7e]$/.test(g) && !isVowel(g);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const EMOJI_RX = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*/gu;

  function isPrime(n) {
    if (n < 2) return false;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
    return true;
  }

  function toRoman(n) {
    const T = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
      [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [v, r] of T) while (n >= v) { out += r; n -= v; }
    return out;
  }

  function gmFetch(url, timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
      GM_xmlhttpRequest({
        method: 'GET', url, timeout,
        onload: (r) => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status + ' ' + url)),
        onerror: () => reject(new Error('net error ' + url)),
        ontimeout: () => reject(new Error('timeout ' + url)),
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Static data
   * ------------------------------------------------------------------ */
  const ELEMENTS = {
    H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10, Na: 11, Mg: 12, Al: 13,
    Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20, Sc: 21, Ti: 22, V: 23, Cr: 24, Mn: 25,
    Fe: 26, Co: 27, Ni: 28, Cu: 29, Zn: 30, Ga: 31, Ge: 32, As: 33, Se: 34, Br: 35, Kr: 36,
    Rb: 37, Sr: 38, Y: 39, Zr: 40, Nb: 41, Mo: 42, Tc: 43, Ru: 44, Rh: 45, Pd: 46, Ag: 47,
    Cd: 48, In: 49, Sn: 50, Sb: 51, Te: 52, I: 53, Xe: 54, Cs: 55, Ba: 56, La: 57, Ce: 58,
    Pr: 59, Nd: 60, Pm: 61, Sm: 62, Eu: 63, Gd: 64, Tb: 65, Dy: 66, Ho: 67, Er: 68, Tm: 69,
    Yb: 70, Lu: 71, Hf: 72, Ta: 73, W: 74, Re: 75, Os: 76, Ir: 77, Pt: 78, Au: 79, Hg: 80,
    Tl: 81, Pb: 82, Bi: 83, Po: 84, At: 85, Rn: 86, Fr: 87, Ra: 88, Ac: 89, Th: 90, Pa: 91,
    U: 92, Np: 93, Pu: 94, Am: 95, Cm: 96, Bk: 97, Cf: 98, Es: 99, Fm: 100, Md: 101, No: 102,
    Lr: 103, Rf: 104, Db: 105, Sg: 106, Bh: 107, Hs: 108, Mt: 109, Ds: 110, Rg: 111, Cn: 112,
    Nh: 113, Fl: 114, Mc: 115, Lv: 116, Ts: 117, Og: 118,
  };

  // Balancer-safe element pool: no uppercase Roman-numeral letters (IVXLCDM),
  // and no symbol whose first letter is itself a one-letter element, so that
  // "greedy longest-match" and "count every match" scanners agree on the sum.
  const SAFE_ELEMENT_POOL = [
    ['U', 92], ['Th', 90], ['Ra', 88], ['Rn', 86], ['At', 85], ['Tl', 81], ['Au', 79],
    ['Re', 75], ['W', 74], ['Ta', 73], ['Tm', 69], ['Er', 68], ['Tb', 65], ['Gd', 64],
    ['Eu', 63], ['Te', 52], ['Ag', 47], ['Rh', 45], ['Ru', 44], ['Tc', 43], ['Zr', 40],
    ['Y', 39], ['Rb', 37], ['As', 33], ['Ge', 32], ['Ga', 31], ['Zn', 30], ['K', 19],
    ['Ar', 18], ['S', 16], ['P', 15], ['Al', 13], ['F', 9], ['O', 8], ['N', 7], ['B', 5],
    ['H', 1],
  ];
  const TWO_LETTER_SAFE = SAFE_ELEMENT_POOL.filter(([s]) => s.length === 2);

  const MONTHS = ['may', 'june', 'july', 'march', 'april', 'august', 'january', 'february',
    'september', 'october', 'november', 'december'];

  const SPONSORS = ['pepsi', 'starbucks', 'shell', 'Pepsi', 'Starbucks', 'Shell'];

  // The game matches the affirmations with spaces stripped ("iamloved"), and
  // contenteditable editors can turn typed spaces into non-breaking spaces
  // anyway — so the spaceless forms go first. Capitalized forms last: their
  // capital I counts as iodine (53) and inflates the element balance while a
  // probe batch is in the password.
  const AFFIRMATIONS = ['iamloved', 'iamworthy', 'iamenough',
    'i am loved', 'i am worthy', 'i am enough',
    'Iamloved', 'I am loved', 'I am worthy', 'I am enough'];

  const ADJACENT_PAIRS = ['hi', 'no', 'op', 'st', 'de', 'ab', 'lm', 'rs', 'tu', 'gh'];

  const COUNTRIES = ['afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia',
    'austria', 'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium',
    'belize', 'benin', 'bhutan', 'bolivia', 'bosnia and herzegovina', 'botswana', 'brazil',
    'brunei', 'bulgaria', 'burkina faso', 'burundi', 'cambodia', 'cameroon', 'canada', 'chad',
    'chile', 'china', 'colombia', 'comoros', 'costa rica', 'croatia', 'cuba', 'cyprus',
    'czech republic', 'czechia', 'denmark', 'djibouti', 'dominican republic', 'dominica',
    'ecuador', 'egypt', 'el salvador', 'equatorial guinea', 'eritrea', 'estonia', 'eswatini',
    'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia', 'germany', 'ghana',
    'greece', 'greenland', 'grenada', 'guatemala', 'guinea', 'guyana', 'haiti', 'honduras',
    'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy',
    'ivory coast', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya', 'kiribati', 'kuwait',
    'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein',
    'lithuania', 'luxembourg', 'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta',
    'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro',
    'morocco', 'mozambique', 'myanmar', 'namibia', 'nauru', 'nepal', 'netherlands',
    'new zealand', 'nicaragua', 'nigeria', 'niger', 'north korea', 'north macedonia', 'norway',
    'oman', 'pakistan', 'palau', 'panama', 'papua new guinea', 'paraguay', 'peru',
    'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda', 'samoa',
    'san marino', 'saudi arabia', 'senegal', 'serbia', 'seychelles', 'sierra leone',
    'singapore', 'slovakia', 'slovenia', 'solomon islands', 'somalia', 'south africa',
    'south korea', 'south sudan', 'spain', 'sri lanka', 'sudan', 'suriname', 'sweden',
    'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania', 'thailand', 'togo', 'tonga',
    'trinidad and tobago', 'tunisia', 'turkey', 'turkmenistan', 'tuvalu', 'uganda', 'ukraine',
    'united arab emirates', 'united kingdom', 'united states', 'uruguay', 'uzbekistan',
    'vanuatu', 'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe',
  ];

  const SAN_RX = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const ST = {
    running: true,
    tick: 0,
    lastCommitTick: -10,
    lastCommittedHTML: null,
    commitStrategy: 0,
    commitMismatchStreak: 0,
    rules: [],
    seenOnce: new Set(),
    maxRuleSeen: 0,
    flags: {
      digitTarget: null, needNumber: false, elementTarget: null, needTwoLetterElement: false,
      boldVowels: false, italic: false, wingRatio: null, tnrRomans: false,
      digitPx: null, letterSizes: false, lengthNum: false, prime: false,
      fireFailing: false, hatched: false, romanProduct: null,
    },
    banned: new Set(),        // sacrificed letters (lowercase)
    probers: new Map(),       // key -> Prober
    machines: {},             // per-rule async state machines
    manual: new Map(),        // ruleNum -> manual override text
    lenOffset: 0,             // game-displayed length minus our grapheme count
    digitConflict: false,
    checkpoint: null,
    checkpointScore: -1,
    lastError: '',
    action: 'booting',
    nextFeedAt: Date.now() + CONFIG.FEED_EVERY_MS,
    won: false,
    dead: false,
    rulesDirty: true,
  };

  /* ------------------------------------------------------------------ *
   * Segment model
   * ------------------------------------------------------------------ */
  const SEG_ORDER = ['egg', 'food', 'base', 'month', 'roman', 'sponsor', 'wordle', 'captcha',
    'country', 'leap', 'moon', 'chess', 'affirm', 'adjacent', 'strong', 'elements', 'video',
    'color', 'time', 'lengthnum', 'digits', 'manual', 'filler'];

  const segs = new Map(); // id -> text
  segs.set('base', 'A!');
  segs.set('digits', '9');
  segs.set('filler', '-'.repeat(CONFIG.MIN_FILLER));

  function segSet(id, text) {
    if (segs.get(id) === text) return false;
    segs.set(id, text);
    return true;
  }
  const segGet = (id) => segs.get(id) || '';

  function orderedSegs() {
    const out = [];
    for (const id of SEG_ORDER) {
      if (id === 'manual') {
        for (const [num, text] of [...ST.manual.entries()].sort((a, b) => a[0] - b[0])) {
          if (text) out.push({ id: 'manual-' + num, text });
        }
      } else {
        const t = segGet(id);
        if (t) out.push({ id, text: t });
      }
    }
    return out;
  }

  // Plain text render: segments joined with '.' so element symbols / month
  // names / probe candidates can never bleed across segment boundaries.
  function renderPlain(overrides) {
    const parts = [];
    for (const s of orderedSegs()) {
      const t = overrides && (s.id in overrides) ? overrides[s.id] : s.text;
      if (t) parts.push(t);
    }
    return parts.join('.');
  }

  function plainExcept(excludeIds) {
    const parts = [];
    for (const s of orderedSegs()) if (!excludeIds.includes(s.id)) parts.push(s.text);
    return parts.join('.');
  }

  /* ------------------------------------------------------------------ *
   * Rich render: per-grapheme marks -> HTML for clipboard paste
   * ------------------------------------------------------------------ */
  function renderRich() {
    const cells = [];
    const ordered = orderedSegs();
    ordered.forEach((s, i) => {
      if (i > 0) cells.push({ g: '.', seg: '::sep' });
      for (const g of graphemes(s.text)) cells.push({ g, seg: s.id });
    });

    const total = cells.length;
    const F = ST.flags;

    const vowelIdx = [];
    cells.forEach((c, i) => { if (isVowel(c.g)) vowelIdx.push(i); });
    const vowels = vowelIdx.length;

    const italicSet = new Set();
    if (F.italic) {
      vowelIdx.forEach((i) => italicSet.add(i));
      let need = vowels; // extras so italic == 2 x bold; ASCII-only keeps counting schemes consistent
      for (const pass of ['filler', null]) {
        for (let i = 0; i < total && need > 0; i++) {
          if (italicSet.has(i)) continue;
          if (pass && cells[i].seg !== pass) continue;
          if (!isAsciiNonVowel(cells[i].g)) continue;
          italicSet.add(i); need--;
        }
        if (need <= 0) break;
      }
    }

    const wingSet = new Set();
    if (F.wingRatio != null) {
      const need = Math.ceil(total * (F.wingRatio + CONFIG.WINGDINGS_MARGIN));
      const prio = ['filler', 'digits', 'elements', 'video', 'captcha', 'country', 'sponsor',
        'month', 'color', 'wordle', 'affirm', 'adjacent', 'leap', 'base', '::sep'];
      const rank = (seg) => { const r = prio.indexOf(seg); return r === -1 ? prio.length : r; };
      const idxs = cells.map((c, i) => i)
        .filter((i) => !(F.tnrRomans && /^[IVXLCDM]$/.test(cells[i].g)))
        .sort((a, b) => rank(cells[a].seg) - rank(cells[b].seg));
      for (const i of idxs) { if (wingSet.size >= need) break; wingSet.add(i); }
    }

    const letterCount = {};
    let html = '';
    for (let i = 0; i < total; i++) {
      const { g } = cells[i];
      let inner = esc(g);
      // <strong>/<em> and the quoted 'Times New Roman' below mirror the exact
      // markup the game's editor is known to accept — don't "simplify" them.
      if (F.boldVowels && isVowel(g)) inner = '<strong>' + inner + '</strong>';
      if (italicSet.has(i)) inner = '<em>' + inner + '</em>';

      let font = null;
      if (F.tnrRomans && /^[IVXLCDM]$/.test(g)) font = "'Times New Roman'";
      else if (wingSet.has(i)) font = 'Wingdings';

      let size = null;
      if (F.digitPx != null && /^[0-9]$/.test(g)) size = F.digitPx;
      else if (F.letterSizes && /^[a-zA-Z]$/.test(g)) {
        const k = g.toLowerCase();
        const n = (letterCount[k] = (letterCount[k] || 0) + 1);
        size = 18 + 2 * n; // any distinct px values satisfy "different sizes per instance"
      }

      if (font || size != null) {
        const style = [font && `font-family: ${font}`, size != null && `font-size: ${size}px`]
          .filter(Boolean).join('; ');
        inner = `<span style="${style}">${inner}</span>`;
      }
      html += inner;
    }
    return { html, plain: cells.map((c) => c.g).join('') };
  }

  /* ------------------------------------------------------------------ *
   * Editor I/O
   *
   * The game's editor is a ProseMirror contenteditable. It does NOT read the
   * password from paste/keydown events — it reads the editor node's own DOM.
   * So the reliable commit is to overwrite `.ProseMirror`'s innerHTML directly
   * (this is exactly what the game's own retype step does internally) and fire
   * one input event so ProseMirror's mutation observer re-scans. Formatting
   * (bold/italic/font) survives because it's real markup in that HTML.
   * ------------------------------------------------------------------ */
  function allEditors() {
    const pm = [...document.querySelectorAll('.password-box .ProseMirror, .ProseMirror')];
    let eds = pm.filter(isVisible);
    if (!eds.length) {
      eds = [...document.querySelectorAll('.password-box input, .password-box textarea, [contenteditable="true"]')].filter(isVisible);
    }
    // The visibility filter only exists to pick the right box; if it rejects
    // everything (headless quirks, mid-layout reads), writing into a
    // "hidden" editor still beats stalling forever.
    if (!eds.length && pm.length) eds = pm;
    return eds;
  }

  // The retype box that appears for the final rule must hold the SAME password
  // as the first box, so we write the model into every visible editor — not
  // just one — keeping them identical. Read/settle uses the last one.
  function findEditor() {
    const eds = allEditors();
    return eds.length ? eds[eds.length - 1] : null;
  }

  const editorText = () => {
    const ed = findEditor();
    if (!ed) return '';
    return (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA' ? ed.value : ed.textContent) || '';
  };

  function writeEditor(ed, html, plain) {
    if (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA') {
      const proto = ed.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(ed, plain);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      ed.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // Overwrite the editor node's own HTML. ProseMirror re-normalizes this
    // (re-wrapping the inline content in its <p>) and its mutation observer
    // notifies the game, which re-validates every rule. A synthetic 'input'
    // nudges any listener that keys off events rather than the observer.
    ed.innerHTML = html;
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: plain }));
  }

  function commitToEditor(html, plain, force) {
    const eds = allEditors();
    if (!eds.length) return false;
    try {
      for (const ed of eds) {
        const cur = (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA') ? ed.value : ed.textContent;
        // The text comparison alone is NOT enough to skip a write: a change of
        // formatting marks (e.g. the bold-vowels flag flipping on) alters the
        // HTML but not the text, and skipping would record the new HTML as
        // committed while the DOM never received it — a permanent stall.
        if (force || cur !== plain) writeEditor(ed, html, plain);
      }
      return true;
    } catch (e) {
      ST.lastError = 'commit: ' + e.message;
      return false;
    }
  }

  function commitIfNeeded() {
    const { html, plain } = renderRich();
    // Recommit when the model changed OR any visible box has drifted from it
    // (fire, eaten caterpillars, or a freshly-appeared empty retype box).
    const allMatch = allEditors().every((ed) =>
      ((ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA') ? ed.value : ed.textContent) === plain);
    if (html === ST.lastCommittedHTML && allMatch) return;
    if (commitToEditor(html, plain, html !== ST.lastCommittedHTML)) {
      ST.lastCommittedHTML = html;
      ST.lastCommitTick = ST.tick;
      ST.modelPlain = plain;
    } else if (!ST.lastError) {
      ST.lastError = 'commit: no editor found to write into';
    }
  }

  function updateSettleTracking() {
    const domText = editorText();
    const model = ST.modelPlain || '';
    if (!model) return;
    if (domText === model) {
      const disp = readDisplayedLength();
      if (disp != null) ST.lenOffset = disp - glen(model);
    } else if (ST.tick - ST.lastCommitTick >= CONFIG.SETTLE_TICKS) {
      // Fire chars and eaten caterpillars legitimately desync the DOM; anything
      // else means our last write didn't stick, so force a re-commit.
      const gameMutation = /🔥/.test(domText) || ST.flags.fireFailing
        || (domText.split('🐛').length < model.split('🐛').length);
      if (!gameMutation) ST.lastCommittedHTML = null;
    }
  }

  const domSettled = () => ST.tick - ST.lastCommitTick >= CONFIG.SETTLE_TICKS;

  function readDisplayedLength() {
    // The game shows its own character count next to the box; trust it over
    // our grapheme math (emoji counting schemes differ).
    for (const el of document.querySelectorAll('[class*="length"]')) {
      if (el.closest('#pgap-hud')) continue;
      const t = (el.textContent || '').trim();
      if (/^\d{1,4}$/.test(t)) return parseInt(t, 10);
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Rule scanning
   * ------------------------------------------------------------------ */
  function scanRules() {
    const out = [];
    for (const el of document.querySelectorAll('.rule')) {
      if (!isVisible(el)) continue;
      const topText = (el.querySelector('.rule-title')?.textContent || el.textContent || '');
      const m = topText.match(/rule\s*(\d+)/i);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      const desc = (el.querySelector('.rule-desc')?.textContent || el.textContent || '').trim();
      // A failing rule carries "rule-error"; a satisfied one drops it (and
      // usually gains "rule-success"). Keying off the error class is robust to
      // the exact success-class name.
      const passed = !el.classList.contains('rule-error')
        && !/\b(invalid|incorrect)\b/i.test(el.className);
      out.push({ num, desc, low: desc.toLowerCase(), el, passed });
    }
    out.sort((a, b) => a.num - b.num);
    return out;
  }

  function clickRefresh(ruleEl) {
    const el = ruleEl.querySelector('.captcha-refresh, .refresh, [class*="refresh"], img[src*="refresh"], button[title*="refresh" i]');
    if (!el) return false;
    (el.closest('button') || el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Prober: batch + binary-search candidate resolution against one rule
   * ------------------------------------------------------------------ */
  class Prober {
    constructor(segId, candidates, opts = {}) {
      this.segId = segId;
      this.cands = candidates.filter((c) => !hasBanned(c));
      this.batchSize = opts.batch || 16;
      this.chunks = chunk(this.cands, this.batchSize);
      this.stack = [];
      this.cur = null;
      this.pendingSince = null;
      this.locked = null;
      this.exhausted = false;
      this.failStreak = 0;
    }

    step(rule) {
      if (this.locked != null) {
        if (!rule.passed && domSettled()) {
          if (++this.failStreak > CONFIG.REPROBE_AFTER_FAILS) this.reset();
        } else if (rule.passed) this.failStreak = 0;
        return;
      }
      if (this.exhausted) {
        // Exhaustion isn't final: the rule may pass via other content, or a
        // transient editor/commit glitch may have poisoned the whole pass —
        // retry from scratch after a cooldown.
        if (rule.passed) { this.exhausted = false; this.lock(''); return; }
        if (ST.tick - this.exhaustedAt > 120) this.reset();
        return;
      }
      if (!domSettled()) return;

      if (this.pendingSince == null) {
        if (rule.passed) { this.lock(''); return; } // already satisfied by other content
        this.advance(this.chunks.shift() || null);
        return;
      }
      if (ST.tick - this.pendingSince < CONFIG.SETTLE_TICKS + 1) return;

      if (rule.passed) {
        if (this.cur.length === 1) { this.lock(this.cur[0]); return; }
        const mid = Math.ceil(this.cur.length / 2);
        this.stack.push(this.cur.slice(mid));
        this.advance(this.cur.slice(0, mid));
      } else {
        this.advance(this.stack.length ? this.stack.pop() : (this.chunks.shift() || null));
      }
    }

    advance(set) {
      this.cur = set;
      if (!set) {
        this.exhausted = true;
        this.exhaustedAt = ST.tick;
        this.pendingSince = null;
        segSet(this.segId, '');
        return;
      }
      segSet(this.segId, set.join('.'));
      this.pendingSince = ST.tick;
    }

    lock(value) {
      this.locked = value;
      this.pendingSince = null;
      segSet(this.segId, value);
    }

    reset() {
      this.chunks = chunk(this.cands, this.batchSize);
      this.stack = [];
      this.cur = null;
      this.locked = null;
      this.exhausted = false;
      this.pendingSince = null;
      this.failStreak = 0;
    }
  }

  function getProber(key, segId, candidatesFn) {
    if (!ST.probers.has(key)) ST.probers.set(key, new Prober(segId, candidatesFn()));
    return ST.probers.get(key);
  }

  function hasBanned(str) {
    for (const ch of str.toLowerCase()) if (ST.banned.has(ch)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Async resource machines
   * ------------------------------------------------------------------ */

  // --- Wordle: ask the game's own API (this is exactly what the game queries,
  // so it can't disagree with an external Wordle source).
  function wordleMachine(rule) {
    const M = ST.machines.wordle || (ST.machines.wordle = { status: 'idle', tries: 0 });
    if (M.status === 'idle') {
      M.status = 'fetching';
      const d = new Date();
      const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const dates = [fmt(d), new Date(d.getTime() - 864e5), new Date(d.getTime() + 864e5)].map((x) => typeof x === 'string' ? x : fmt(x));
      (async () => {
        for (const date of dates) {
          try {
            const r = await fetch(`https://neal.fun/api/password-game/wordle?date=${date}`);
            if (!r.ok) continue;
            const j = await r.json();
            if (j && j.answer) { M.answer = String(j.answer).toLowerCase(); M.status = 'have'; return; }
          } catch (e) { /* try next date */ }
        }
        try {
          const iso = dates[0];
          const txt = await gmFetch(`https://www.nytimes.com/svc/wordle/v2/${iso}.json`);
          const j = JSON.parse(txt);
          if (j.solution) { M.answer = j.solution.toLowerCase(); M.status = 'have'; return; }
        } catch (e) { /* fall through */ }
        M.status = 'failed';
        ST.lastError = 'wordle answer fetch failed';
      })();
    } else if (M.status === 'have') {
      const p = getProber('wordle', 'wordle', () => [M.answer, M.answer.toUpperCase()]);
      p.step(rule);
    }
  }

  // --- CAPTCHA: code is the image filename; refresh until it carries no
  // digits (protects the digit-sum budget) and no uppercase Roman letters.
  function captchaMachine(rule) {
    const M = ST.machines.captcha || (ST.machines.captcha = { refreshes: 0, lastSrc: null, waitUntil: 0 });
    const img = rule.el.querySelector('.captcha-img, img[src*="captcha"]');
    if (!img) return;
    // The captcha text is the image's own filename, e.g. ".../a1b2c3.png".
    const m = (img.getAttribute('src') || '').match(/\/([a-z0-9]+)\.(?:png|jpg|jpeg|webp)/i);
    if (!m) return;
    const code = m[1];
    if (Date.now() < M.waitUntil) return;
    const bad = digitSum(code) > 0 || /[IVXLCDM]/.test(code) || hasBanned(code);
    if (bad && M.refreshes < CONFIG.CAPTCHA_MAX_REFRESH) {
      if (clickRefresh(rule.el)) {
        M.refreshes++;
        M.waitUntil = Date.now() + 700;
        return;
      }
    }
    segSet('captcha', code);
  }

  // --- Color: swatch is an inline background style inside the rule; the rule
  // ships its own refresh button, so reroll until the hex is digit-cheap.
  function colorMachine(rule) {
    const M = ST.machines.color || (ST.machines.color = { refreshes: 0, waitUntil: 0 });
    if (Date.now() < M.waitUntil) return;
    let hex = null;
    const swatches = rule.el.querySelectorAll('.rand-color, [style*="background"]');
    for (const el of swatches) {
      const bg = el.style.backgroundColor || getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        hex = [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
        break;
      }
    }
    if (!hex) return;
    if (digitSum(hex) > CONFIG.COLOR_DIGIT_MAX && M.refreshes < CONFIG.COLOR_MAX_REFRESH) {
      if (clickRefresh(rule.el)) { M.refreshes++; M.waitUntil = Date.now() + 700; return; }
    }
    segSet('color', '#' + hex);
  }

  // --- Chess: the board is a static asset (chess/puzzleN.svg) and the answer
  // list ships inside the site's own JS bundle; extract it rather than running
  // an engine. Off-by-one on the index is resolved by probing both.
  function chessMachine(rule) {
    const M = ST.machines.chess || (ST.machines.chess = { status: 'idle' });
    if (M.status === 'idle') {
      const img = rule.el.querySelector('.chess-img, img[src*="chess"], img[src*="puzzle"]');
      const m = img && (img.getAttribute('src') || '').match(/puzzle(\d+)/i);
      if (!m) return;
      M.puzzle = parseInt(m[1], 10);
      M.status = 'loading';
      (async () => {
        try {
          let blob = '';
          for (const s of document.querySelectorAll('script')) {
            if (s.src) {
              try {
                const u = new URL(s.src, location.href);
                if (u.origin === location.origin) blob += await (await fetch(u.href)).text();
              } catch (e) { /* skip unfetchable bundle */ }
            } else blob += s.textContent || '';
          }
          let best = null;
          // Form 1: a plain array of SAN strings.
          for (const cand of blob.match(/\[(?:\s*"[^"]{2,10}"\s*,){20,}\s*"[^"]{2,10}"\s*\]/g) || []) {
            try {
              const arr = JSON.parse(cand);
              const ratio = arr.filter((x) => SAN_RX.test(x)).length / arr.length;
              if (ratio > 0.9 && arr.length >= 30 && (!best || arr.length > best.length)) best = arr;
            } catch (e) { /* not JSON */ }
          }
          // Form 2 (what neal.fun actually ships): an array of puzzle objects,
          // each with a SAN answer under sol/move/answer/best/san. Collect those
          // values in bundle order — that order is the puzzle index.
          if (!best) {
            const moves = [];
            const rx = /(?:sol|move|answer|best|san)\s*:\s*["']([^"']{2,8})["']/g;
            let m;
            while ((m = rx.exec(blob))) if (SAN_RX.test(m[1])) moves.push(m[1]);
            if (moves.length >= 30) best = moves;
          }
          if (best) { M.solutions = best; M.status = 'have'; }
          else { M.status = 'failed'; ST.lastError = 'chess: solution list not found in bundle — click the rule in the HUD to type the move (e.g. Qh5#)'; }
        } catch (e) {
          M.status = 'failed';
          ST.lastError = 'chess: ' + e.message;
        }
      })();
    } else if (M.status === 'have') {
      const cands = [M.solutions[M.puzzle - 1], M.solutions[M.puzzle], M.solutions[M.puzzle + 1]]
        .filter((x, i, a) => x && SAN_RX.test(x) && a.indexOf(x) === i);
      const p = getProber('chess', 'chess', () => cands);
      p.step(rule);
    }
  }

  // --- YouTube: exact-duration lookup. "N minute M second timer" videos are a
  // reliably indexed genre; Piped/Invidious search results expose durations in
  // seconds without an API key. Data API v3 is used when a key is configured.
  function youtubeMachine(rule) {
    const M = ST.machines.youtube || (ST.machines.youtube = { status: 'idle', queue: [], tried: new Set(), probeStart: 0, formatIdx: 0 });
    if (M.status === 'idle') {
      const mm = rule.low.match(/(\d+)\s*minute/);
      const ss = rule.low.match(/(\d+)\s*second/);
      M.secs = (mm ? +mm[1] : 0) * 60 + (ss ? +ss[1] : 0);
      if (!M.secs) { M.status = 'failed'; ST.lastError = 'youtube: could not parse duration from rule'; return; }
      M.status = 'searching';
      searchYoutube(M).then((ids) => {
        M.queue = ids;
        M.status = ids.length ? 'probing' : 'exhausted';
        if (!ids.length) ST.lastError = `youtube: no video found for ${M.secs}s (add to YT_FALLBACK_POOL or use manual override)`;
      });
    } else if (M.status === 'probing') {
      if (rule.passed) { M.status = 'locked'; return; }
      const now = Date.now();
      if (M.current && now - M.probeStart < CONFIG.YT_PROBE_TIMEOUT_MS) return;
      if (M.current && M.formatIdx === 0) {
        M.formatIdx = 1; // same id, alternate URL shape
        segSet('video', `youtu.be/${M.current}`);
        M.probeStart = now;
        return;
      }
      M.current = M.queue.shift();
      M.formatIdx = 0;
      if (!M.current) { M.status = 'exhausted'; segSet('video', ''); return; }
      segSet('video', `youtube.com/watch?v=${M.current}`);
      M.probeStart = now;
    } else if (M.status === 'locked' && !rule.passed && domSettled()) {
      M.failStreak = (M.failStreak || 0) + 1;
      if (M.failStreak > CONFIG.REPROBE_AFTER_FAILS) { M.status = 'probing'; M.failStreak = 0; }
    }
  }

  // A video id containing uppercase roman letters would multiply into the
  // roman-numeral product — except runs of a single "I", which multiply by 1
  // and are harmless.
  const okVideoId = (id) => /^[\w-]{11}$/.test(id) && !hasBanned(id)
    && (id.match(/[IVXLCDM]+/g) || []).every((run) => run === 'I');

  // Community-curated duration→video map from Mabi19's password-game-tas
  // (fetched from where the author published it, at runtime, so we don't
  // redistribute the data). Values are "<11-char video id><element padding>";
  // the durations are the ones the game's own API reports, which occasionally
  // differ by ±1s from what YouTube search displays.
  let TAS_MAP = null;
  async function tasDurationMap() {
    if (TAS_MAP) return TAS_MAP;
    const src = await gmFetch('https://update.greasyfork.org/scripts/480234/The%20Password%20Game%20%28TAS%20Userscript%29.user.js', 20000);
    const map = {};
    const rx = /"(\d{1,2}:\d{2})"\s*:\s*"([\w-]{11,20})"/g;
    let m;
    while ((m = rx.exec(src))) map[m[1]] = m[2].slice(0, 11);
    if (!Object.keys(map).length) throw new Error('duration map empty');
    return (TAS_MAP = map);
  }

  // Scrape a youtube.com search-results page for (videoId, displayed length)
  // pairs. Results are videoRenderer JSON blobs; lengthText nests an
  // accessibility object before its simpleText, hence the loose middle match.
  function parseYtSearch(html) {
    const out = [];
    const seen = new Set();
    for (const chunk of html.split('"videoRenderer":{"videoId":"').slice(1)) {
      const id = chunk.slice(0, 11);
      if (!/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const lm = chunk.slice(0, 6000).match(/"lengthText":\{.{0,400}?"simpleText":"(\d+(?::\d{2}){1,2})"/);
      if (!lm) continue;
      out.push({ id, s: lm[1].split(':').map(Number).reduce((a, p) => a * 60 + p, 0) });
    }
    return out;
  }

  async function searchYoutube(M) {
    const secs = M.secs;
    const mins = Math.floor(secs / 60), rem = secs % 60;
    const key = `${mins}:${String(rem).padStart(2, '0')}`;
    // candidates are probed cheapest-first: tier, then digit/element cost
    const score = (id) => digitSum(id) * 2 + scanElements(id) / 50;
    const found = new Map();
    const add = (id, tier) => { if (okVideoId(id) && !found.has(id)) found.set(id, tier * 1000 + score(id)); };

    (YT_FALLBACK_POOL[secs] || []).forEach((id) => add(id, 0));

    try {
      const map = await tasDurationMap();
      if (map[key]) add(map[key], 1);
    } catch (e) { ST.lastError = 'youtube: duration map unavailable (' + e.message + '), falling back to search'; }

    const queries = [
      `${mins} minute ${rem} second timer`,
      `${mins} minutes ${rem} seconds timer`,
      `${mins} minute ${rem} second countdown`,
      `"${key}" timer`,
    ];

    for (const q of queries) {
      if (found.size >= 4) break;
      try {
        const html = await gmFetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, 12000);
        for (const { id, s } of parseYtSearch(html)) {
          if (s === secs) add(id, 2);
          else if (s === secs + 1) add(id, 4); // display rounding can be +1 vs the game's API
        }
      } catch (e) { /* search page unreachable; try next query */ }
    }

    if (CONFIG.YT_API_KEY && found.size < 4) {
      try {
        const apiKey = CONFIG.YT_API_KEY;
        for (const q of queries.slice(0, 2)) {
          const s = JSON.parse(await gmFetch(`https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=25&q=${encodeURIComponent(q)}&key=${apiKey}`));
          const ids = (s.items || []).map((i) => i.id.videoId).filter(Boolean);
          if (!ids.length) continue;
          const v = JSON.parse(await gmFetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${apiKey}`));
          for (const it of v.items || []) {
            const d = it.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            const dur = (+(d[1] || 0)) * 3600 + (+(d[2] || 0)) * 60 + (+(d[3] || 0));
            if (dur === secs) add(it.id, 2);
          }
        }
      } catch (e) { ST.lastError = 'youtube api: ' + e.message; }
    }

    // Last resort: public Piped/Invidious instances (most are dead or blocked,
    // but they cost nothing to try when everything above came up empty).
    if (!found.size) {
      for (const base of ['https://pipedapi.adminforge.de', 'https://api.piped.private.coffee']) {
        try {
          const j = JSON.parse(await gmFetch(`${base}/search?q=${encodeURIComponent(queries[0])}&filter=videos`, 8000));
          for (const it of j.items || []) {
            if (it.duration === secs && it.url) add((it.url.match(/v=([\w-]+)/) || [])[1] || '', 5);
          }
          break;
        } catch (e) { /* dead instance, next */ }
      }
    }

    return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }

  // --- Sacrifice: pick two letters that appear nowhere in the password and
  // will never be needed later (a-f stay reserved for the hex color rule).
  function sacrificeMachine(rule) {
    const M = ST.machines.sacrifice || (ST.machines.sacrifice = { chosen: null, clicked: new Set(), confirmAt: 0 });
    if (!M.chosen) {
      const present = new Set(renderPlain().toLowerCase());
      const prefs = ['j', 'q', 'z', 'w', 'x', 'k', 'v', 'g', 'p', 'y', 'h', 'u', 'n', 'l', 't', 'r', 's', 'm', 'o'];
      const picks = prefs.filter((c) => !present.has(c)).slice(0, 2);
      if (picks.length < 2) { ST.lastError = 'sacrifice: fewer than 2 unused letters available'; return; }
      M.chosen = picks;
    }
    // Letter tiles live in ".sacrafice-area .letters" (the game's own spelling);
    // each child's text contains a single letter. Fall back to a broad scan.
    const tiles = rule.el.querySelectorAll('.sacrafice-area .letters *, .sacrifice-area .letters *, button, div, span, li');
    for (const el of tiles) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (t.length === 1 && M.chosen.includes(t) && !M.clicked.has(t)) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        M.clicked.add(t);
      }
    }
    if (M.clicked.size >= 2 && Date.now() > M.confirmAt) {
      const btn = rule.el.querySelector('.sacrafice-btn, .sacrifice-btn')
        || [...rule.el.querySelectorAll('button')].find((b) => /sacrifice|confirm|submit/i.test(b.textContent || ''));
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      M.confirmAt = Date.now() + 1000;
      M.chosen.forEach((c) => ST.banned.add(c));
    }
  }

  // --- Time: the accepted format (12h vs 24h, zero-padded or not) is learned
  // once by probing, then re-rendered every minute.
  function timeMachine(rule) {
    const M = ST.machines.time || (ST.machines.time = { fmt: null, probing: null, idx: 0, probeTick: -10, minute: -1 });
    const now = new Date();
    const fmts = [
      (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
      (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      (d) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`,
    ];
    if (M.fmt != null) {
      segSet('time', fmts[M.fmt](now));
      if (!rule.passed && domSettled() && ++M.failStreak > CONFIG.REPROBE_AFTER_FAILS) { M.fmt = null; M.failStreak = 0; }
      if (rule.passed) M.failStreak = 0;
      return;
    }
    if (now.getMinutes() !== M.minute) { M.minute = now.getMinutes(); M.idx = 0; M.probeTick = -10; }
    if (!domSettled() || ST.tick - M.probeTick < CONFIG.SETTLE_TICKS + 1) return;
    if (M.probeTick > 0 && rule.passed) { M.fmt = M.probing; return; }
    M.probing = M.idx % fmts.length;
    segSet('time', fmts[M.probing](now));
    M.probeTick = ST.tick;
    M.idx++;
  }

  // --- Final confirmation: click through "is this your final password?" and
  // let the normal commit loop repopulate the (now empty) retype box.
  function finalMachine(rule) {
    const M = ST.machines.final || (ST.machines.final = { lastClick: 0 });
    // Once the retype box exists the commit loop keeps both boxes in sync — the
    // rule passes on its own, so there is nothing left to click.
    if (allEditors().length > 1 || document.querySelector('.retype-box')) return;
    // Confirm only when every OTHER rule is green and the password has stopped
    // changing. Clicking early freezes the first box at a half-built password
    // that the (still-evolving) retype can never match.
    const othersPass = ST.rules.every((r) => r.num === rule.num || r.passed);
    const stable = ST.tick - ST.lastCommitTick >= 6;
    if (!othersPass || !stable) { ST.action = 'final: waiting for a stable, all-green password'; return; }
    if (Date.now() - M.lastClick < 1200) return;
    const btn = document.querySelector('.final-password button')
      || [...rule.el.querySelectorAll('button')].find((b) =>
        /yes|final|confirm|continue|✓/i.test(b.textContent || ''));
    if (btn && isVisible(btn)) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      M.lastClick = Date.now();
      ST.lastCommittedHTML = null; // force a recommit to fill the new retype box
    }
  }

  /* ------------------------------------------------------------------ *
   * Derived segments: digit balancer, element balancer, length/prime filler
   * ------------------------------------------------------------------ */
  function scanElements(text) {
    let sum = 0;
    for (let i = 0; i < text.length; i++) {
      const two = text.substr(i, 2);
      if (ELEMENTS[two] != null) { sum += ELEMENTS[two]; i++; continue; }
      if (ELEMENTS[text[i]] != null) sum += ELEMENTS[text[i]];
    }
    return sum;
  }

  function composeElements(target, mustIncludeTwoLetter) {
    if (target < 0) return null;
    const pool = SAFE_ELEMENT_POOL.filter(([s]) => !hasBanned(s));
    let prefix = [];
    if (mustIncludeTwoLetter) {
      const two = TWO_LETTER_SAFE.find(([s, v]) => !hasBanned(s) && v <= target);
      if (two) { prefix = [two[0]]; target -= two[1]; }
    }
    const best = new Array(target + 1).fill(null);
    best[0] = [];
    for (let t = 1; t <= target; t++) {
      for (const [sym, val] of pool) {
        if (val <= t && best[t - val] && (!best[t] || best[t - val].length + 1 < best[t].length)) {
          best[t] = best[t - val].concat(sym);
        }
      }
    }
    return best[target] ? prefix.concat(best[target]) : null;
  }

  function updateElementBalancer() {
    const F = ST.flags;
    if (F.elementTarget == null) {
      if (F.needTwoLetterElement && !segGet('elements')) {
        const two = TWO_LETTER_SAFE.find(([s]) => !hasBanned(s));
        if (two) segSet('elements', two[0]);
      }
      return;
    }
    const fixed = scanElements(plainExcept(['elements']));
    const rem = F.elementTarget - fixed;
    const combo = composeElements(rem, F.needTwoLetterElement);
    if (combo) {
      segSet('elements', combo.join(''));
      // overshoot is usually transient (a probe batch with capital I = iodine
      // sitting in the password); drop the stale error once we recover
      if (/^elements:/.test(ST.lastError)) ST.lastError = '';
    } else {
      segSet('elements', '');
      if (rem !== 0) ST.lastError = `elements: cannot reach ${F.elementTarget} (fixed=${fixed})`;
    }
  }

  function updateLengthAndFiller() {
    const F = ST.flags;
    const plainNoFiller = () => renderPlain({ filler: '' });
    const vowels = (renderPlain().match(/[aeiouyAEIOUY]/g) || []).length;
    const asciiAvail = graphemes(renderPlain({ filler: '' })).filter(isAsciiNonVowel).length;
    const minFiller = Math.max(CONFIG.MIN_FILLER, F.italic ? Math.max(0, vowels - asciiAvail) + CONFIG.MIN_FILLER : CONFIG.MIN_FILLER);

    if (!F.lengthNum && !F.prime) {
      segSet('filler', '-'.repeat(minFiller));
      return;
    }

    const fixedDigits = digitSum(renderPlain({ digits: '', lengthnum: '', filler: '' }));
    const budget = (F.digitTarget != null ? F.digitTarget : 25) - fixedDigits;

    for (let T = 0, guard = 0; guard < 500; guard++) {
      const lenStr = F.lengthNum ? String(tryT(guard)) : '';
      // base = displayed length with this length-number and a single filler char
      const base = glen(renderPlain({ lengthnum: lenStr, filler: '-' })) - 1 + ST.lenOffset;
      T = F.lengthNum ? tryT(guard) : base + minFiller + guard;
      if (F.prime && !isPrime(T)) continue;
      if (F.lengthNum && digitSum(String(T)) > budget) continue;
      const fillerN = T - base;
      if (fillerN < minFiller) continue;
      segSet('lengthnum', F.lengthNum ? String(T) : '');
      segSet('filler', '-'.repeat(fillerN));
      return;
    }

    function tryT(guard) {
      const approx = glen(plainNoFiller()) + ST.lenOffset + minFiller + 2;
      return approx + guard;
    }
  }

  function updateDigitBalancer() {
    const F = ST.flags;
    if (F.digitTarget == null) {
      if (F.needNumber && !/[0-9]/.test(plainExcept(['digits']))) segSet('digits', '9');
      else if (F.needNumber) segSet('digits', '');
      return;
    }
    const others = digitSum(plainExcept(['digits']));
    const rem = F.digitTarget - others;
    if (rem < 0) {
      ST.digitConflict = true;
      segSet('digits', '');
      return;
    }
    ST.digitConflict = false;
    let out = '';
    let r = rem;
    while (r > 9) { out += '9'; r -= 9; }
    if (r > 0) out += String(r);
    segSet('digits', out);
  }

  function recomputeDerived() {
    for (let i = 0; i < 4; i++) {
      const before = renderPlain();
      updateElementBalancer();
      updateLengthAndFiller();
      updateDigitBalancer();
      if (renderPlain() === before) break;
    }
  }

  /* ------------------------------------------------------------------ *
   * Rule handlers (matched by text, never by hardcoded rule number)
   * ------------------------------------------------------------------ */
  const HANDLERS = [
    { key: 'skip', rx: /skip this one/, },
    { key: 'final', rx: /final password|re-?type your password/, onFail: finalMachine },
    { key: 'atomic', rx: /atomic number|elements.*add up/, onSeen: (r) => { const m = r.low.match(/add up to (\d+)/); ST.flags.elementTarget = m ? +m[1] : 200; } },
    { key: 'digitsum', rx: /digits.*add up to/, onSeen: (r) => { const m = r.low.match(/add up to (\d+)/); ST.flags.digitTarget = m ? +m[1] : 25; } },
    { key: 'feed', rx: /don'?t forget to feed|feed him|has hatched/, onSeen: () => { ST.flags.hatched = true; segSet('egg', '🐔'); segSet('food', '🐛'.repeat(CONFIG.FOOD_TARGET)); } },
    { key: 'egg', rx: /chicken|🥚|keep him safe/, onSeen: () => { if (!ST.flags.hatched) segSet('egg', '🥚'); } },
    { key: 'fire', rx: /on fire|put it out/, onFail: () => { ST.flags.fireFailing = true; } },
    // 'tnr' must be matched before the generic roman handlers: rule 29 ("All
    // roman numerals must be in Times New Roman") also contains "roman
    // numeral" and would be swallowed by them, leaving the flag unset.
    { key: 'tnr', rx: /times new roman/, onSeen: () => { ST.flags.tnrRomans = true; } },
    { key: 'romanmul', rx: /roman numerals.*multiply|multiply to/, onSeen: (r) => { const m = r.low.match(/multiply to (\d+)/); ST.flags.romanProduct = m ? +m[1] : 35; segSet('roman', toRoman(ST.flags.romanProduct)); } },
    { key: 'roman', rx: /roman numeral/, onSeen: () => { if (!segGet('roman')) segSet('roman', 'XXXV'); } },
    { key: 'length5', rx: /at least \d+ characters/ },
    { key: 'number', rx: /include a number/, onSeen: () => { ST.flags.needNumber = true; } },
    { key: 'upper', rx: /uppercase letter/, onSeen: () => { if (!/[A-Z]/.test(segGet('base'))) segSet('base', 'A!' ); } },
    { key: 'special', rx: /special character/ },
    // Probers are stepped every tick (onTick), not only while failing: after a
    // batch makes the rule pass they must keep narrowing (binary search) down
    // to a single value and lock, otherwise the password stays bloated and the
    // segment never stabilises for the final retype.
    //
    // Lowercase months only: the rule matches case-insensitively, and a
    // capitalized "May"/"March"/"December" would inject an uppercase roman
    // letter (M, D) that breaks the roman-numerals-multiply rule.
    { key: 'month', rx: /month of the year/, onTick: (r) => getProber('month', 'month', () => MONTHS.slice()).step(r) },
    { key: 'sponsor', rx: /sponsor/, onTick: (r) => getProber('sponsor', 'sponsor', () => SPONSORS).step(r) },
    { key: 'captcha', rx: /captcha/, onFail: captchaMachine },
    { key: 'wordle', rx: /wordle/, onTick: wordleMachine },
    { key: 'periodic', rx: /two letter symbol|periodic table/, onSeen: () => { ST.flags.needTwoLetterElement = true; } },
    // Include all eight lunar-phase glyphs at once: whichever one the game
    // wants is guaranteed present, and the extras are inert everywhere else.
    // Far more reliable than computing/guessing a single phase.
    { key: 'moon', rx: /phase of the moon/, onSeen: () => segSet('moon', '🌑🌒🌓🌔🌕🌖🌗🌘') },
    { key: 'country', rx: /name of this country|country/, onTick: (r) => getProber('country', 'country', () => COUNTRIES.slice()).step(r) },
    { key: 'leap', rx: /leap year/, onSeen: () => segSet('leap', '2000') },
    { key: 'chess', rx: /chess|algebraic/, onTick: chessMachine },
    { key: 'strong', rx: /strong enough/, onSeen: (r) => { const e = (r.desc.match(EMOJI_RX) || ['🏋️‍♂️'])[0]; segSet('strong', e.repeat(3)); }, onFail: strongAdaptive },
    { key: 'affirm', rx: /affirmation/, onTick: (r) => getProber('affirm', 'affirm', () => AFFIRMATIONS).step(r) },
    { key: 'bold', rx: /vowel.*bold|bold.*vowel/, onSeen: () => { ST.flags.boldVowels = true; } },
    { key: 'youtube', rx: /youtube/, onFail: youtubeMachine },
    { key: 'sacrifice', rx: /sacrifice|no longer be able to use/, onFail: sacrificeMachine },
    { key: 'italic', rx: /italic/, onSeen: () => { ST.flags.italic = true; } },
    { key: 'wingdings', rx: /wingdings/, onSeen: (r) => { const m = r.low.match(/(\d+)\s*%/); ST.flags.wingRatio = m ? (+m[1]) / 100 : 0.3; } },
    { key: 'hex', rx: /hex/, onFail: colorMachine },
    { key: 'digitpx', rx: /font size.*digit|digit.*font size|numbers?.*(50|px)/, onSeen: (r) => { const m = r.low.match(/(\d+)\s*px/); ST.flags.digitPx = m ? +m[1] : 50; } },
    { key: 'lettersizes', rx: /same letter|every instance|different font size/, onSeen: () => { ST.flags.letterSizes = true; } },
    { key: 'includelength', rx: /include the length|length of your password.*include|include.*length of/, onSeen: () => { ST.flags.lengthNum = true; } },
    { key: 'prime', rx: /prime/, onSeen: () => { ST.flags.prime = true; } },
    // onTick (not onFail): the minute rollover must refresh the segment even
    // while the rule is currently green.
    { key: 'time', rx: /current time/, onTick: timeMachine },
    { key: 'adjacent', rx: /adjacent (in|on) the alphabet|alphabet.*adjacent/, onTick: (r) => getProber('adjacent', 'adjacent', () => ADJACENT_PAIRS).step(r) },
  ];

  function strongAdaptive(rule) {
    const M = ST.machines.strong || (ST.machines.strong = { count: 3, lastBump: 0, stuckSince: null });
    if (rule.passed) { M.stuckSince = null; return; }
    if (!domSettled()) return;
    if (M.stuckSince == null) M.stuckSince = ST.tick;
    if (ST.tick - M.stuckSince > 40) {
      M.count = (M.count % 6) + 1;
      const e = (rule.desc.match(EMOJI_RX) || ['🏋️‍♂️'])[0];
      segSet('strong', e.repeat(M.count));
      M.stuckSince = ST.tick;
    }
  }

  function matchHandler(rule) {
    for (const h of HANDLERS) if (h.rx.test(rule.low)) return h;
    return null;
  }

  // Unknown rules: try any emoji or quoted token the rule text itself offers.
  function genericFallback(rule) {
    const key = 'generic-' + rule.num;
    if (!ST.probers.has(key)) {
      const tokens = [];
      (rule.desc.match(EMOJI_RX) || []).forEach((e) => tokens.push(e));
      (rule.desc.match(/"([^"]+)"|“([^”]+)”/g) || []).forEach((q) => tokens.push(q.replace(/["“”]/g, '')));
      if (!tokens.length) {
        if (!ST.manual.has(rule.num)) ST.lastError = `no handler for rule ${rule.num}: "${rule.desc.slice(0, 60)}" (click it in the HUD to type a fix)`;
        return;
      }
      SEG_ORDER.splice(SEG_ORDER.indexOf('filler'), 0, 'generic-' + rule.num);
      ST.probers.set(key, new Prober('generic-' + rule.num, tokens));
    }
    ST.probers.get(key).step(rule);
  }

  /* ------------------------------------------------------------------ *
   * Checkpointing
   * ------------------------------------------------------------------ */
  function maybeCheckpoint() {
    const passed = ST.rules.filter((r) => r.passed).length;
    if (ST.rules.length && passed === ST.rules.length && passed > ST.checkpointScore) {
      ST.checkpoint = JSON.stringify([...segs.entries()]);
      ST.checkpointScore = passed;
      ST.stuckSince = null;
    }
  }

  function maybeRollback() {
    const failing = ST.rules.filter((r) => !r.passed);
    if (!failing.length) { ST.stuckSince = null; return; }
    const proberActive = [...ST.probers.values()].some((p) => p.pendingSince != null)
      || ['searching', 'probing', 'loading', 'fetching'].includes(ST.machines.youtube?.status)
      || ST.machines.chess?.status === 'loading';
    if (proberActive) { ST.stuckSince = null; return; }
    if (ST.stuckSince == null) { ST.stuckSince = ST.tick; return; }
    const stuckMs = (ST.tick - ST.stuckSince) * CONFIG.TICK_MS;
    if (stuckMs > 90000 && ST.checkpoint) {
      ST.lastError = 'stuck >90s; rolling back to last checkpoint';
      for (const [k, v] of JSON.parse(ST.checkpoint)) segs.set(k, v);
      ST.probers.clear();
      ST.stuckSince = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Death / win watchers
   *
   * The win and death screens are pre-rendered in the DOM and merely hidden
   * (display:none / off-screen) until triggered — so scanning raw textContent
   * matches them on the very first tick and falsely reports a win. We must only
   * read text from elements that are actually VISIBLE.
   * ------------------------------------------------------------------ */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function visibleText() {
    // Walk visible leaf-ish nodes only. Cheap enough at our tick rate.
    let out = '';
    const walk = (el) => {
      if (el.id === 'pgap-hud' || el.nodeType !== 1) return;
      if (!isVisible(el)) return;
      if (!el.children.length) { out += ' ' + (el.textContent || ''); return; }
      for (const c of el.children) walk(c);
    };
    for (const el of document.body.children) walk(el);
    return out;
  }

  const DEATH_RX = /paul (was|has been) (slain|killed|eaten)|paul (died|is dead|starved|burned)|you (killed|starved|overfed) paul|game\s*over/i;
  const WIN_RX = /you win|you won|password game complete|you'?ve? (beaten|won|completed)/i;

  function watchDeathWin() {
    const t = visibleText();
    // A real win also means every rule that ever existed is gone/passed; require
    // that corroboration so a stray matching string can't end the run early.
    const noFailing = ST.rules.length > 0 && ST.rules.every((r) => r.passed);
    if (WIN_RX.test(t) && (noFailing || ST.maxRuleSeen >= 20)) {
      ST.won = true;
      ST.running = false;
      ST.action = 'WON 🎉';
      return;
    }
    if (DEATH_RX.test(t)) {
      ST.dead = true;
      ST.running = false;
      ST.action = 'Paul is gone — restarting run';
      setTimeout(() => location.reload(), CONFIG.RESTART_DELAY_MS);
    }
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */
  let hudEl = null;
  function buildHud() {
    hudEl = document.createElement('div');
    hudEl.id = 'pgap-hud';
    hudEl.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(16,16,24,.92);color:#dfe;padding:10px 12px;border-radius:8px;font:12px/1.5 monospace;max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,.5);pointer-events:auto;';
    document.body.appendChild(hudEl);
    hudEl.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.act === 'toggle') { ST.running = !ST.running; renderHud(); }
      else if (t.dataset.act === 'reload') location.reload();
      else if (t.dataset.rule) {
        const num = +t.dataset.rule;
        const cur = ST.manual.get(num) || '';
        const v = prompt(`Manual text for rule ${num} (empty clears):`, cur);
        if (v !== null) { v ? ST.manual.set(num, v) : ST.manual.delete(num); }
      }
    });
  }

  function renderHud() {
    if (!hudEl) return;
    const failing = ST.rules.filter((r) => !r.passed);
    const feedIn = Math.max(0, Math.ceil((ST.nextFeedAt - Date.now()) / 1000));
    const rows = failing.slice(0, 6).map((r) =>
      `<div data-rule="${r.num}" style="cursor:pointer;color:#fa5">✗ ${r.num}: ${esc(r.desc.slice(0, 42))}</div>`).join('');
    hudEl.innerHTML =
      `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
        <strong>PG-Autoplay</strong>
        <button data-act="toggle" style="cursor:pointer">${ST.running ? 'Pause' : 'Resume'}</button>
        <button data-act="reload" style="cursor:pointer">Restart</button>
      </div>
      <div>rules: ${ST.rules.filter((r) => r.passed).length}/${ST.rules.length} ok (max seen ${ST.maxRuleSeen})</div>
      ${ST.flags.hatched ? `<div>paul: 🐔 next top-up in ${feedIn}s</div>` : ''}
      ${ST.digitConflict ? '<div style="color:#fa5">digit budget exceeded — waiting (time/minute may fix it)</div>' : ''}
      <div>${esc(ST.action)}</div>
      ${rows}
      ${ST.lastError ? `<div style="color:#f77">${esc(ST.lastError.slice(0, 90))}</div>` : ''}
      ${ST.won ? '<div style="color:#7f7;font-size:16px">🏆 WIN</div>' : ''}
      ${ST.dead ? '<div style="color:#f77">💀 restarting…</div>' : ''}`;
  }

  /* ------------------------------------------------------------------ *
   * Main loops
   * ------------------------------------------------------------------ */
  function tick() {
    ST.tick++;
    try {
      if (ST.running && !ST.won && !ST.dead) {
        watchDeathWin();
        if (!ST.won && !ST.dead) {
          ST.rules = scanRules();
          ST.maxRuleSeen = Math.max(ST.maxRuleSeen, ...ST.rules.map((r) => r.num), 0);
          updateSettleTracking();

          ST.flags.fireFailing = false;
          for (const r of ST.rules) {
            const h = matchHandler(r);
            if (h) {
              // rule objects are rebuilt on every scan, so once-only setup is
              // keyed by rule number, not by object identity
              if (h.onSeen && !ST.seenOnce.has(r.num)) { h.onSeen(r); ST.seenOnce.add(r.num); }
              if (h.onTick) h.onTick(r);
              if (!r.passed && h.onFail) h.onFail(r);
            } else if (!r.passed) genericFallback(r);
          }

          recomputeDerived();
          // Watchdog: whatever else goes wrong (stale comparisons, a silently
          // rejected write), a failing rule with a quiet editor for >10s means
          // our view of the DOM can't be trusted — force a full rewrite.
          if (ST.rules.some((r) => !r.passed) && ST.tick - ST.lastCommitTick > 40) {
            ST.lastCommittedHTML = null;
          }
          commitIfNeeded();
          maybeCheckpoint();
          maybeRollback();

          const failing = ST.rules.filter((r) => !r.passed);
          ST.action = failing.length
            ? `solving rule ${failing[0].num}`
            : (ST.rules.length ? 'all visible rules pass — waiting for next' : 'waiting for rules');
        }
      }
    } catch (e) {
      ST.lastError = 'tick: ' + (e && e.message || e);
    }
    renderHud();
    setTimeout(tick, ST.flags.fireFailing ? CONFIG.FIRE_TICK_MS : CONFIG.TICK_MS);
  }

  // Paul feeder: independent of the solve loop so a stuck rule can never
  // starve him. The model keeps FOOD_TARGET caterpillars; this loop forces a
  // top-up commit even if the main loop believes nothing changed.
  function feederTick() {
    if (!ST.running || !ST.flags.hatched || ST.won || ST.dead) {
      ST.nextFeedAt = Date.now() + CONFIG.FEED_EVERY_MS;
      return;
    }
    if (Date.now() >= ST.nextFeedAt) {
      ST.nextFeedAt = Date.now() + CONFIG.FEED_EVERY_MS;
      segSet('food', '🐛'.repeat(CONFIG.FOOD_TARGET));
      const domFood = (editorText().match(/🐛/g) || []).length;
      if (domFood < CONFIG.FOOD_TARGET) {
        ST.lastCommittedHTML = null; // force the next commit through
        commitIfNeeded();
      }
    }
  }

  // Safety net death watcher, in case the main loop is wedged mid-await.
  function safetyTick() {
    if (ST.won || ST.dead) return;
    if (DEATH_RX.test(visibleText())) {
      ST.dead = true;
      ST.running = false;
      setTimeout(() => location.reload(), CONFIG.RESTART_DELAY_MS);
    }
  }

  function boot() {
    if (!findEditor()) { setTimeout(boot, 500); return; }
    buildHud();
    new MutationObserver(() => { ST.rulesDirty = true; }).observe(document.body, { childList: true, subtree: true });
    tick();
    setInterval(feederTick, 1000);
    setInterval(safetyTick, 800);
    window.PGAP = { state: ST, segs, segSet, renderRich, allEditors, stop: () => { ST.running = false; }, start: () => { ST.running = true; } };
  }

  boot();
})();
