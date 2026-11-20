// Project I.G.I. in the browser: copies the player's own game folder into OPFS (once; it never leaves the
// computer), starts the recompiled build (build/recomp.js), replays its frames with WebGPU and feeds it
// input and audio.
//
// URL options: ?mute (no audio) ?fps (frame rate in the console) ?log (host log) ?autoplay
//              ?devgame (download the hosted game folder without asking; testing)
//              ?touch (on-screen controls even without a touch screen) ?touchsens=<x> (extra look factor; the
//              settings sheet on the phone is the normal way)
//              ?exe=<name> (the executable inside the game folder, if not the profile's default)
//              ?pads=N (game controllers to expose, default 1, at most 4)
//              ?queue=1 (frames queued ahead of the display, default 2: 1 cuts 16 ms of input latency online
//              on a machine that simulates a frame well within 16 ms, else it hitches)
//              ?netplay=<url> (the room server for online play, see server/; default: this page's origin)
//              ?join=<room code>
//
// Online play (netplay.js, host/netplay.c): players meet in a room on the server; when the host starts,
// every page boots the game in deterministic lockstep mode with fresh saves, and only pad inputs travel.
// Each player's keyboard and first gamepad merge into one local pad; mouse and raw keys are off.
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const EXPERIMENTS = { wide: 100, compact: 0 };
const COHORT = (() => {
  let b = 99, off = {};
  try {
    b = parseInt(localStorage.getItem('igi-bucket'), 10);
    if (!(b >= 0 && b < 100)) { b = Math.floor(Math.random() * 100); localStorage.setItem('igi-bucket', String(b)); }
    off = JSON.parse(localStorage.getItem('igi-exp-off') || '{}') || {};
  } catch { b = 99; }
  const on = {};
  for (const [k, pct] of Object.entries(EXPERIMENTS)) on[k] = !off[k] && b < pct;
  let choice = null;
  try { choice = localStorage.getItem('igi-wide-choice'); } catch { /* storage blocked */ }
  if (choice === '1') on.wide = true;
  if (choice === '0') on.wide = false;
  if (params.has('widemodes')) on.wide = true;
  if (params.has('nowidemodes')) on.wide = false;
  if (params.get('mem') === 'compact') on.compact = true;
  if (params.get('mem') === 'full') on.compact = false;
  return { bucket: b, on, tag: (Object.keys(on).filter((k) => on[k]).join('+') || 'base') + (choice !== null ? '+pick' : '') };
})();
try { RcControls.get().wide = COHORT.on.wide; } catch { /* controls.js not loaded */ }
window.RC_WIDE_RUNNING = COHORT.on.wide;

const OPFS_DIR = 'rcgame';
const MARKER = '.installed.json';   // { version } once every file is copied
const NETPLAY_BASE = new URL(params.get('netplay') || './', location.href).href.replace(/\/?$/, '/');
const status = (t) => {
  const el = $('status');
  if (el) el.textContent = t;
  const sMsg = $('status-msg');
  if (sMsg) {
    sMsg.textContent = t;
    sMsg.className = 'status-msg';
  }
  const lSub = $('loading-subtext');
  if (lSub && $('status-overlay')?.style.display !== 'none') {
    lSub.textContent = t;
  }
};
// the launcher's screens (index.html): loading, home, online, lobby
const show = (view) => {
  document.body.classList.toggle('loading-gate', view === 'loading');
  if (view === 'home') document.body.classList.remove('loading-gate');
  for (const v of document.querySelectorAll('#panel .view')) v.classList.toggle('hidden', v.id !== 'view-' + view);
  const home = $('home-view');
  const game = $('game-container');
  const overlay = $('status-overlay');
  if (view === 'home') {
    if (home) home.style.display = 'flex';
    if (game) game.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
  } else if (view === 'loading') {
    if (home) home.style.display = 'none';
    if (game) game.style.display = 'block';
    if (overlay) overlay.style.display = 'flex';
  }
};
const fail = (e) => {
  hideBoot();
  status('Error: ' + e.message);
  const sMsg = $('status-msg');
  if (sMsg) {
    sMsg.textContent = 'Error: ' + e.message;
    sMsg.className = 'status-msg error';
  }
  show('home');
};
const mb = (n) => (n / 1e6).toFixed(0);

// Rotating "intel" tips: a one-time 500 MB download and the first-mission load both take a minute, so the
// wait gets real game tips and a little lore instead of a bare progress bar. Each tip fades to the next.
const TIPS = [
  'You are David Llewellyn Jones — ex-SAS, going in alone.',
  'Open the map computer to see guard positions update in real time.',
  'Silence is a weapon: the knife and silenced pistol keep you unheard.',
  'Cut the alarm before a guard reaches the panel, or the whole base wakes up.',
  'Crouch to steady your aim and shrink your profile.',
  'Scout with the binoculars before you cross open ground.',
  'A headshot drops a guard before he can radio for backup.',
  'Lofted grenades clear a room you can’t safely walk into.',
  'Anya runs mission control from the air — the clock is always ticking.',
  'This is the real 2000 game: about 500 MB, downloaded to your device once.',
  'Nothing leaves your computer — the whole game runs inside your browser.',
  'The first start is the slow one: after this the game opens straight away.',
];
function startTips(box) {
  if (!box) return () => {};
  const textEl = box.querySelector('.tip-text');
  if (!textEl) return () => {};
  box.classList.remove('hidden');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = Math.floor(Math.random() * TIPS.length);
  const render = () => { textEl.textContent = TIPS[i % TIPS.length]; i++; };
  render();
  const next = () => {
    if (reduce) { render(); return; }
    box.style.opacity = '0';
    setTimeout(() => { render(); box.style.opacity = '1'; }, 350);
  };
  const id = setInterval(next, 4800);
  return () => { clearInterval(id); box.classList.add('hidden'); box.style.opacity = ''; };
}

// Boot overlay (index.html #status-overlay): between the Play click and the first rendered frame the canvas is a
// black void while the game loads a mission into memory. Cover it with the styled loading progress bar.
let stopBootTips = null;
function showBoot() {
  const home = $('home-view');
  if (home) home.style.display = 'none';
  const game = $('game-container');
  if (game) game.style.display = 'block';
  const stage = $('stage');
  if (stage) stage.style.display = 'block';

  const overlay = $('status-overlay');
  if (overlay) overlay.style.display = 'flex';
  const lText = $('loading-text');
  const lSub = $('loading-subtext');
  const lFill = $('loading-bar-fill');
  const lPct = $('loading-percent');
  if (lText) lText.textContent = 'STARTING...';
  if (lSub) lSub.textContent = 'Loading game...';
  if (lFill) lFill.style.width = '100%';
  if (lPct) lPct.textContent = '100%';

  const b = $('booting');
  if (b) {
    const phase = b.querySelector('.boot-phase');
    if (phase) phase.textContent = 'Starting the game…';
    b.classList.remove('hidden');
    stopBootTips = startTips(b.querySelector('.tips'));
  }

  showBoot.t1 = setTimeout(() => { if (lSub) lSub.textContent = 'Loading the game into memory…'; }, 12000);
  showBoot.t2 = setTimeout(() => { if (lSub) lSub.textContent = 'The first launch is the slow one — almost there…'; }, 45000);
  showBoot.t3 = setTimeout(() => { if (lSub) lSub.textContent = 'Still working — a slow device can take a couple of minutes…'; }, 90000);
  showBoot.t4 = setTimeout(hideBoot, 300000);   // safety: never trap the player behind the cover
}
function hideBoot() {
  for (const k of ['t1', 't2', 't3', 't4']) clearTimeout(showBoot[k]);
  const overlay = $('status-overlay');
  if (overlay) overlay.style.display = 'none';
  const b = $('booting');
  if (stopBootTips) { stopBootTips(); stopBootTips = null; }
  if (b) { b.classList.add('hidden'); b.onpointerdown = null; }
}

// Mid-game loading cover: after boot, the game blocks hard (no frames presented) while it loads a selected
// mission or the next level — up to a couple of minutes on a phone, a black screen that looks frozen.
let stopLoadTips = null;
function showLoading() {
  const overlay = $('status-overlay');
  if (overlay) overlay.style.display = 'flex';
  const lText = $('loading-text');
  const lSub = $('loading-subtext');
  const lFill = $('loading-bar-fill');
  const lPct = $('loading-percent');
  if (lText) lText.textContent = 'LOADING MISSION...';
  if (lSub) lSub.textContent = 'Loading mission… please wait';
  if (lFill) lFill.style.width = '100%';
  if (lPct) lPct.textContent = '';

  const b = $('booting');
  if (b) {
    const phase = b.querySelector('.boot-phase');
    if (phase) phase.textContent = 'Loading mission…';
    b.classList.remove('hidden');
    stopLoadTips = startTips(b.querySelector('.tips'));
  }

  showLoading.t1 = setTimeout(() => { if (lSub) lSub.textContent = 'Loading mission… a device can take a minute or two.'; }, 15000);
  showLoading.t2 = setTimeout(() => { if (lSub) lSub.textContent = 'Still loading — hang tight, almost there…'; }, 50000);
}
function hideLoading() {
  for (const k of ['t1', 't2']) clearTimeout(showLoading[k]);
  const overlay = $('status-overlay');
  if (overlay) overlay.style.display = 'none';
  const b = $('booting');
  if (stopLoadTips) { stopLoadTips(); stopLoadTips = null; }
  if (b) b.classList.add('hidden');
}

// On-screen diagnostics for phones (no devtools): ?debug shows a log overlay capturing errors, warnings,
// unhandled rejections and lost-GPU events, so a remote tester can screenshot exactly what failed (e.g. a
// mission that won't load). Harmless when off.
const DEBUG = params.has('debug');
(function setupDebugLog() {
  if (!DEBUG) return;
  const box = document.createElement('div');
  box.id = 'debuglog';
  box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:45vh;overflow:auto;z-index:99999;' +
    'background:rgba(0,0,0,.85);color:#9fe6b0;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px 10px;' +
    'white-space:pre-wrap;word-break:break-word;border-top:2px solid #2ecc71';
  const add = (tag, args) => {
    const line = document.createElement('div');
    line.textContent = tag + ' ' + args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (tag === 'ERR') line.style.color = '#ff8b8b';
    box.appendChild(line); box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 300) box.firstChild.remove();
  };
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  if (document.body) document.body.appendChild(box);
  const oe = console.error, ow = console.warn, ol = console.log;
  console.error = (...a) => { add('ERR', a); oe.apply(console, a); };
  console.warn = (...a) => { add('WARN', a); ow.apply(console, a); };
  console.log = (...a) => { add('log', a); ol.apply(console, a); };
  window.addEventListener('error', (e) => add('ERR', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => add('ERR', ['unhandled rejection:', e.reason]));
  add('log', ['debug log on · ' + navigator.userAgent]);
})();

// Surface WebGPU failures (console.error, so the ?debug overlay shows them): a mission that exceeds a mobile
// GPU's buffer/texture limits, or a lost device (out of memory), otherwise fails silently to a black screen.
if (navigator.gpu && GPUAdapter.prototype.requestDevice) {
  const orig = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (desc) {
    try {
      const dev = await orig.call(this, desc);
      try {
        dev.addEventListener('uncapturederror', (e) => console.error('WebGPU uncaptured error:', e.error?.message || e.error));
        dev.lost.then((info) => console.error('WebGPU device lost:', info.reason, info.message));
      } catch {}
      return dev;
    } catch (e) { console.error('WebGPU requestDevice failed:', e.message); throw e; }
  };
}

// ------------------------------------------------------------------ game files in OPFS

async function gameDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

async function readMarker() {
  try {
    const f = await (await (await gameDir(false)).getFileHandle(MARKER)).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

async function writeMarker(version) {
  const fh = await (await gameDir(true)).getFileHandle(MARKER, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ version, at: new Date().toISOString() }));
  await w.close();
}

async function manifestVersion(list) {
  const sig = list.map((e) => `${e.path ?? e.dest}:${e.size ?? e.f?.size}`).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fileHandle(dir, relPath, create) {
  const parts = relPath.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

// installer leftovers the game never reads: not worth copying into the browser
const SKIP = /^(directx[^/]*\/|.*\.(mp4|ds_store)$)|(^|\/)\.DS_Store$/i;

async function importFromPicker(fileList) {
  // the whole folder, minus its own name: <picked>/a/b.dat -> a/b.dat
  const list = [...fileList].map((f) => ({ f, dest: f.webkitRelativePath.split('/').slice(1).join('/') }))
    .filter((e) => e.dest && !SKIP.test(e.dest));
  if (!list.some((e) => e.dest.toLowerCase() === 'igi.exe'))
    throw new Error('No igi.exe in that folder: pick the Project I.G.I. folder itself.');
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(OPFS_DIR, { recursive: true }); } catch {}
  await navigator.storage.persist?.();
  const dir = await gameDir(true);
  const total = list.reduce((s, e) => s + e.f.size, 0);
  let done = 0;
  $('progress').classList.remove('hidden');
  for (const e of list) {
    status(`Copying ${e.dest} (${mb(done)} / ${mb(total)} MB)`);
    const w = await (await fileHandle(dir, e.dest, true)).createWritable();
    await w.write(e.f);
    await w.close();
    done += e.f.size;
    $('progress').value = done / total;
  }
  await writeMarker(await manifestVersion(list));
  await prepareGameFiles();
  $('progress').classList.add('hidden');
}

// A hosted copy of the game folder: web/serve.py --game DIR serves it at game/, with game/manifest.json
// listing [{ path, size }]. Each file streams straight into OPFS (a phone couldn't hold 500 MB in memory),
// and files already there at the right size are kept, so an interrupted download resumes where it stopped.
async function hostedManifest() {
  try {
    const r = await fetch('game/manifest.json');
    if (!r.ok) return null;
    const list = (await r.json()).filter((e) => !SKIP.test(e.path));
    return list.some((e) => e.path.toLowerCase() === 'igi.exe') ? list : null;
  } catch { return null; }
}

// The game folder is served through a CDN (Cloudflare) that caches it on an edge near the player, so one
// host is already fast: the files are pulled by a pool of workers over the browser's single multiplexed
// HTTP/2 connection. Each streams straight into OPFS and files already at the right size are skipped, so an
// interrupted download resumes where it stopped.
const DL_CONCURRENCY = 2;
const PACKS_DONE_FILE = '.packs.done.json';

async function readPacksDone(dir) {
  try {
    const f = await (await dir.getFileHandle(PACKS_DONE_FILE)).getFile();
    return new Set(JSON.parse(await f.text()));
  } catch { return new Set(); }
}

async function writePacksDone(dir, doneSet) {
  try {
    const fh = await dir.getFileHandle(PACKS_DONE_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify([...doneSet]));
    await w.close();
  } catch {}
}

async function importFromServer(list) {
  const stopTips = startTips($('tips'));
  try {
    await importFromServerInner(list);
  } finally {
    stopTips();
  }
}

async function importFromServerInner(list) {
  await navigator.storage.persist?.();
  const dir = await gameDir(true);

  const packsRes = await fetch('game/packs.json', { cache: 'no-store' });
  if (!packsRes.ok) throw new Error(`Failed to load game/packs.json (HTTP ${packsRes.status})`);
  const packs = await packsRes.json();

  const total = packs.reduce((s, p) => s + p.size, 0);
  const donePacks = await readPacksDone(dir);
  let done = 0, inFlight = 0, shownAt = 0;
  for (const p of packs) {
    if (donePacks.has(p.file)) done += p.size;
  }

  const startT = performance.now();
  let baseDone = null, baseT = 0;   // a steady-state anchor (set after ~1.5s) so the ETA isn't noisy at the start

  const home = $('home-view');
  if (home) home.style.display = 'none';
  const game = $('game-container');
  if (game) game.style.display = 'block';
  const overlay = $('status-overlay');
  if (overlay) overlay.style.display = 'flex';
  const lText = $('loading-text');
  const lSub = $('loading-subtext');
  const lFill = $('loading-bar-fill');
  const lPct = $('loading-percent');
  if (lText) lText.textContent = 'LOADING...';
  if (lSub) lSub.textContent = 'Loading game files — this happens only once, be patient.';
  const initPct = Math.min(100, (done / total) * 100);
  if (lFill) lFill.style.width = initPct.toFixed(1) + '%';
  if (lPct) lPct.textContent = Math.floor(initPct) + '%';

  if ($('progress')) $('progress').classList.remove('hidden');
  const etaText = (secs) => {
    secs = Math.round(secs);
    if (secs >= 110) return `about ${Math.round(secs / 60)} minutes left`;
    if (secs >= 50) return 'about a minute left';
    if (secs >= 18) return `about ${Math.round(secs / 10) * 10} seconds left`;
    return 'a few seconds left';
  };
  const shown = (force) => {
    const now = performance.now();
    if (!force && now - shownAt < 80) return;
    shownAt = now;
    const cur = Math.min(total, Math.max(0, done + inFlight));
    const exactPct = Math.min(100, (cur / total) * 100);
    const pct = Math.min(100, Math.floor(exactPct));
    if (lFill) lFill.style.width = exactPct.toFixed(1) + '%';
    if (lPct) lPct.textContent = pct + '%';
    if ($('progress')) $('progress').value = cur / total;
    if (baseDone === null && now - startT > 1200) { baseDone = cur; baseT = now; }
    let etaStr = '';
    if (baseDone !== null && cur < total) {
      const rate = (cur - baseDone) / Math.max(0.5, (now - baseT) / 1000);
      if (rate > 30000) {
        etaStr = etaText((total - cur) / rate);
        if ($('eta')) { $('eta').textContent = etaStr; $('eta').classList.remove('hidden'); }
      }
    }
    if (lSub) {
      lSub.textContent = etaStr
        ? `Loading game files (${mb(cur)} / ${mb(total)} MB) — ${etaStr}`
        : `Loading game files (${mb(cur)} / ${mb(total)} MB) — happens only once`;
    }
  };
  shown(true);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Unpack a single compressed pack inside a dedicated Web Worker using createSyncAccessHandle() for fast OPFS writes
  const workerScript = `
    'use strict';
    const dirCache = new Map();
    async function getFileHandle(rootDir, relPath) {
      const parts = relPath.split('/');
      let d = rootDir;
      let curPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        curPath = curPath ? curPath + '/' + parts[i] : parts[i];
        let cached = dirCache.get(curPath);
        if (!cached) {
          cached = await d.getDirectoryHandle(parts[i], { create: true });
          dirCache.set(curPath, cached);
        }
        d = cached;
      }
      return d.getFileHandle(parts[parts.length - 1], { create: true });
    }
    async function writeFileFast(fh, bytes) {
      if (fh.createSyncAccessHandle) {
        const sh = await fh.createSyncAccessHandle();
        try {
          sh.truncate(0);
          sh.write(bytes, { at: 0 });
          sh.flush();
        } finally {
          sh.close();
        }
      } else {
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      }
    }
    self.onmessage = async (ev) => {
      const { url, count, opfsDir } = ev.data;
      try {
        const root = await navigator.storage.getDirectory();
        const gDir = await root.getDirectoryHandle(opfsDir, { create: true });
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const netReader = r.body.getReader();
        const trackedStream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await netReader.read();
            if (done) { controller.close(); return; }
            self.postMessage({ type: 'progress', bytes: value.byteLength });
            controller.enqueue(value);
          }
        });
        const ds = new DecompressionStream('gzip');
        const reader = trackedStream.pipeThrough(ds).getReader();
        const dec = new TextDecoder();
        let buf = new Uint8Array(0);
        let head = 0;
        const avail = () => buf.length - head;
        const ensure = async (n) => {
          while (avail() < n) {
            const { done, value } = await reader.read();
            if (done) throw new Error('Unexpected EOF while unpacking');
            const rem = avail();
            const next = new Uint8Array(rem + value.byteLength);
            if (rem > 0) next.set(buf.subarray(head), 0);
            next.set(value, rem);
            buf = next;
            head = 0;
          }
        };
        const take = (n) => {
          const slice = buf.subarray(head, head + n);
          head += n;
          if (head === buf.length) { buf = new Uint8Array(0); head = 0; }
          else if (head > 131072) { buf = buf.subarray(head); head = 0; }
          return slice;
        };
        for (let i = 0; i < count; i++) {
          await ensure(6);
          const hdr = take(6);
          const pathLen = hdr[0] | (hdr[1] << 8);
          const fileSize = (hdr[2] | (hdr[3] << 8) | (hdr[4] << 16) | (hdr[5] << 24)) >>> 0;
          await ensure(pathLen);
          const relPath = dec.decode(take(pathLen));
          await ensure(fileSize);
          const fileBytes = take(fileSize);
          const fh = await getFileHandle(gDir, relPath);
          await writeFileFast(fh, fileBytes);
        }
        self.postMessage({ type: 'done' });
      } catch (err) {
        self.postMessage({ type: 'error', message: err?.message || String(err) });
      }
    };
  `;
  const workerBlobUrl = URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' }));

  const fetchAndUnpackPart = (pack) => new Promise((resolve, reject) => {
    let partInFlight = 0;
    const w = new Worker(workerBlobUrl);
    const cleanup = () => {
      try { w.terminate(); } catch {}
    };
    w.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'progress') {
        partInFlight += d.bytes;
        inFlight += d.bytes;
        shown();
      } else if (d.type === 'done') {
        inFlight -= partInFlight;
        cleanup();
        resolve();
      } else if (d.type === 'error') {
        inFlight -= partInFlight;
        shown();
        cleanup();
        reject(new Error(d.message));
      }
    };
    w.onerror = (err) => {
      inFlight -= partInFlight;
      shown();
      cleanup();
      reject(new Error(err?.message || 'Worker error'));
    };
    w.postMessage({
      url: new URL('game/' + pack.file, location.href).href,
      count: pack.count,
      opfsDir: OPFS_DIR
    });
  });

  const queue = packs.filter((p) => !donePacks.has(p.file));

  const poolWorker = async () => {
    for (;;) {
      const pack = queue.shift();
      if (!pack) return;
      let ok = false, lastErr;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        try {
          await fetchAndUnpackPart(pack);
          ok = true;
        } catch (err) {
          lastErr = err;
          if (attempt < 4) await sleep(500 * (attempt + 1));
        }
      }
      if (!ok) {
        URL.revokeObjectURL(workerBlobUrl);
        throw new Error(`Download failed at ${pack.file} (${lastErr?.message}). Reload the page to resume where it stopped.`);
      }
      done += pack.size;
      donePacks.add(pack.file);
      await writePacksDone(dir, donePacks);
      shown(true);
    }
  };

  try {
    const workers = Array.from({ length: Math.min(DL_CONCURRENCY, queue.length) }, () => poolWorker());
    await Promise.all(workers);
  } finally {
    URL.revokeObjectURL(workerBlobUrl);
  }

  shown(true);
  if (lSub) lSub.textContent = 'Download complete. Setting up...';
  await writeMarker(await manifestVersion(list));
  // Prepare NoCD patch / default config / AFP stubs now, so the first PLAY does not
  // trigger an immediate game-exit + page reload (the main cause of "click twice").
  await prepareGameFiles();
  try { await dir.removeEntry(PACKS_DONE_FILE); } catch {}
  if ($('progress')) $('progress').classList.add('hidden');
  if ($('eta')) $('eta').classList.add('hidden');
}

// ------------------------------------------------------------------ input

// KeyboardEvent.code -> USB HID usage (what host/input.c's key table uses)
const HID = {};
for (let i = 0; i < 26; i++) HID['Key' + String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) HID['Digit' + i] = 29 + i;
HID.Digit0 = 39;
Object.assign(HID, {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
});
for (let i = 1; i <= 12; i++) HID['F' + i] = 57 + i;
for (let i = 1; i <= 9; i++) HID['Numpad' + i] = 88 + i;

// Netplay: the keyboard drives this player's pad (the game itself gets no keys or mouse, which would desync).
// Bit 4 is LB, which the game sees as L1: its modifier for lofted shots (the in-game tutorial: "L1 + shot
// button" to hit a six; on the keyboard that's Shift), so Shift holds it as well as Q. The game pauses only
// on the keyboard's Esc, not the pad's Start, so Esc is bit 20: host/netplay.c applies it to the DirectInput
// keyboard on every peer, with the pad inputs (NP_KEY_ESC). Backspace is B, back in menus.
const NET_KEYS = {   // KeyboardEvent.code -> standard-gamepad bit (20: Esc key)
  Enter: 0, Space: 0, KeyS: 0, Escape: 20, Backspace: 1, KeyD: 1, KeyA: 2, KeyW: 3, KeyQ: 4, KeyE: 5,
  ShiftLeft: 4, ShiftRight: 4,
  Digit1: 6, Digit3: 7, Tab: 8, KeyP: 9, ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15,
};
let netKeyBits = 0;
let netKeyPressed = 0;   // keys pressed since the last poll, so a tap shorter than a frame still counts

// ---- Single-player key remapping ----------------------------------------------------------------
// The game's own control bindings (its config.qvm) stay at their defaults; here we translate the
// player's chosen physical keys onto the game's default key for each action, entirely in the browser
// and saved per browser (localStorage), so keys can be rebound without touching the game. Netplay is
// unaffected: online, the keyboard only drives the pad (above), never raw keys.
// Two layouts ("presets"): the game's ORIGINAL keys (arrows, Right Shift, Right Ctrl, numpad; what the game's
// own Configuration screen shows, and what players of the 2000 game remember) and a MODERN WASD layout. The
// original one is the default for new players, as the game ships; a few extra keys stand in for the numpad
// and Right Ctrl that laptops don't have. Keys not listed here reach the game unchanged in both layouts.
// id, label, { original, modern }: default physical KeyboardEvent.code per preset (null = unbound), the game's
// default key for that action (its code), group
const CONTROLS = [
  ['forward', 'Move forward',   { original: 'ArrowUp',      modern: 'KeyW' },        'ArrowUp',      'Movement'],
  ['back',    'Move backward',  { original: 'ArrowDown',    modern: 'KeyS' },        'ArrowDown',    'Movement'],
  ['left',    'Strafe left',    { original: 'ArrowLeft',    modern: 'KeyA' },        'ArrowLeft',    'Movement'],
  ['right',   'Strafe right',   { original: 'ArrowRight',   modern: 'KeyD' },        'ArrowRight',   'Movement'],
  ['walkrun', 'Walk / run',     { original: 'KeyW',         modern: 'ShiftLeft' },   'KeyW',         'Movement'],
  ['crouch',  'Crouch',         { original: 'ControlRight', modern: 'ControlLeft' }, 'ControlRight', 'Movement'],
  ['crouch2', 'Crouch (alt)',   { original: 'ControlLeft',  modern: null },          'ControlRight', 'Movement'],
  ['jump',    'Jump',           { original: 'Numpad0',      modern: 'Space' },       'Numpad0',      'Movement'],
  ['jump2',   'Jump (alt)',     { original: 'KeyX',         modern: null },          'Numpad0',      'Movement'],
  ['peek',    'Peek',           { original: 'Numpad1',      modern: 'KeyQ' },        'Numpad1',      'Movement'],
  ['peek2',   'Peek (alt)',     { original: 'KeyQ',         modern: 'KeyE' },        'Numpad1',      'Movement'],
  ['reload',  'Reload',         { original: 'Enter',        modern: 'KeyR' },        'Enter',        'Weapons & action'],
  ['zoomin',  'Zoom in',        { original: 'PageUp',       modern: 'Digit1' },      'PageUp',       'Weapons & action'],
  ['zoomout', 'Zoom out',       { original: 'PageDown',     modern: 'Digit3' },      'PageDown',     'Weapons & action'],
  ['use',     'Use / activate', { original: 'ShiftRight',   modern: 'Tab' },         'ShiftRight',   'Weapons & action'],
  ['bino',    'Binoculars',     { original: 'Space',        modern: 'KeyB' },        'Space',        'Weapons & action'],   // in the modern layout Space is Jump
];
const PRESETS = { original: 'Original (as the game ships)', modern: 'Modern (WASD)' };
const CONTROL_STORE = 'igi-controls';
const PRESET_STORE = 'igi-preset';
let preset = 'original';
// how a KeyboardEvent.code reads on screen
function keyLabel(code) {
  if (!code) return '—';
  const m = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', AltLeft: 'L-Alt', AltRight: 'R-Alt', Space: 'Space',
    Enter: 'Enter', NumpadEnter: 'Num ⏎', Tab: 'Tab', Escape: 'Esc', Backspace: '⌫', CapsLock: 'Caps',
    PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Ins', Delete: 'Del',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  if (m[code]) return m[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
let userKeys = {};   // id -> physical KeyboardEvent.code
let keyRemap = {};   // physical code -> HID usage to send to the game
function rebuildRemap() {
  keyRemap = {};
  for (const [id, , , target] of CONTROLS) {
    const phys = userKeys[id], u = HID[target];
    if (phys && u !== undefined) keyRemap[phys] = u;
  }
}
function loadControls() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CONTROL_STORE) || '{}') || {}; } catch { saved = {}; }
  try { if (PRESETS[localStorage.getItem(PRESET_STORE)]) preset = localStorage.getItem(PRESET_STORE); } catch { /* storage blocked */ }
  userKeys = {};
  for (const [id, , def] of CONTROLS) userKeys[id] = typeof saved[id] === 'string' || saved[id] === null ? saved[id] : def[preset];
  rebuildRemap();
}
function saveControls() {
  try { localStorage.setItem(CONTROL_STORE, JSON.stringify(userKeys)); localStorage.setItem(PRESET_STORE, preset); } catch { /* storage blocked */ }
}
function applyPreset(name) {
  preset = PRESETS[name] ? name : 'original';
  for (const [id, , def] of CONTROLS) userKeys[id] = def[preset];
  saveControls(); rebuildRemap();
}
// Players from before the layouts existed (the site remapped to WASD then, with no choice) keep WASD: their
// saved keys, or, with none saved, the modern preset when the game was already installed in this browser
// (boot() calls this once it knows). New players get the game's own keys.
function migratePreset(installed) {
  let had = false;
  try { had = localStorage.getItem(PRESET_STORE) !== null; } catch { /* storage blocked */ }
  if (had) return;
  let custom = false;
  try { custom = localStorage.getItem(CONTROL_STORE) !== null; } catch { /* storage blocked */ }
  if (custom) { preset = 'modern'; saveControls(); loadControls(); }
  else if (installed) applyPreset('modern');
  else applyPreset('original');
  setupControls.render?.();
}
loadControls();

// The keyboard panel (index.html #kbd) doubles as the rebind UI: click a key, then press the new one.

function subtitles(M, touch) {
  const box = $('subcap');
  if (!box || !M._rc_subtitle || !touch) return;
  let last = '', lastSeen = 0, lastBox = '';
  const dec = new TextDecoder('latin1');
  const canvas = $('canvas'), stage = $('stage');
  setInterval(() => {
    let text = '', b = null, col = 0;
    try {
      if (RcControls.get().subs) {
        const p = M._rc_subtitle(), mem = new Uint8Array(M.wasmMemory.buffer, p, 512);
        const end = mem.indexOf(0);
        text = dec.decode(mem.slice(0, end < 0 ? 512 : end));
        if (text && M._rc_subtitle_box) { b = Array.from(new Float32Array(M.wasmMemory.buffer, M._rc_subtitle_box(), 5)); col = M._rc_subtitle_color() >>> 0; }
      }
    } catch { text = ''; }
    const now = performance.now();
    if (text) lastSeen = now;
    if (!text) { if (last && now - lastSeen > 500) { last = ''; box.classList.add('hidden'); } return; }
    const r = canvas.getBoundingClientRect(), S = stage.getBoundingClientRect();
    const h = Math.min(r.height, (r.width * 3) / 4), w = (h * 4) / 3;
    const ox = r.left - S.left + (r.width - w) / 2, oy = r.top - S.top + (r.height - h) / 2;
    const geo = b ? b.map((v) => v.toFixed(3)).join() + '|' + Math.round(w) : '';
    if (text === last && geo === lastBox) return;
    last = text; lastBox = geo;
    const rgb = [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    const green = rgb[1] > 120 && rgb[1] > rgb[0] * 1.4;
    box.className = green ? 'panel' : 'band';
    box.style.color = col ? `rgb(${rgb.join()})` : '';
    const fs = Math.max(14, Math.min(22, h * 0.04));
    box.style.fontSize = `${fs}px`;
    let x0 = ox + w * 0.05, y0 = oy + h * 0.85, width = w * 0.9, room = h * 0.15;
    if (b && b[2] > b[0]) {
      x0 = Math.max(ox, ox + b[0] * w - 4); y0 = Math.max(oy, oy + b[1] * h - 3);
      width = Math.min(w - (x0 - ox) - 2, Math.max((b[2] - b[0]) * w + 8, w * 0.5));
      room = green ? Math.max((b[3] - b[1]) * h * 2.2, h * 0.16) : oy + h - y0;
    }
    box.style.left = `${x0}px`; box.style.top = `${y0}px`; box.style.width = `${width}px`; box.style.transform = 'none';
    box.textContent = text.replace(/\n/g, ' ');
    for (let f = fs; f >= 14; f -= 1) { box.style.fontSize = `${f}px`; if (box.scrollHeight <= room + 1) break; }
    if (box.scrollHeight > room + 1 && !green) box.style.top = `${Math.max(oy, oy + h - box.scrollHeight)}px`;
  }, 120);
}

function setupControls() {
  const host = $('kbd-binds');
  if (!host) return;
  let capturing = null;   // id being rebound
  const groups = [];
  for (const c of CONTROLS) {
    let g = groups.find((x) => x.name === c[4]);
    if (!g) groups.push(g = { name: c[4], items: [] });
    g.items.push(c);
  }
  const render = () => {
    host.innerHTML = groups.map((g) =>
      `<div style="margin-top:12px;margin-bottom:6px;font-size:0.75rem;letter-spacing:1px;text-transform:uppercase;color:var(--accent);font-weight:700;">${g.name}</div>` +
      g.items.map(([id, label]) =>
        `<div class="bind-row"><span class="bind-label">${label}</span>` +
        `<button type="button" class="kbd-rebind${capturing === id ? ' capturing' : ''}" data-id="${id}">` +
        `${capturing === id ? 'press…' : keyLabel(userKeys[id])}</button></div>`).join('')
    ).join('');
    host.querySelectorAll('.kbd-rebind').forEach((b) => {
      b.onclick = () => { capturing = capturing === b.dataset.id ? null : b.dataset.id; render(); };
    });
  };
  setupControls.render = render;
  // While rebinding, grab the next key in the capture phase so it reaches neither the page nor the game.
  window.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Backspace' || e.code === 'Delete') { userKeys[capturing] = null; saveControls(); rebuildRemap(); }   // unbind
    else if (e.code !== 'Escape' && HID[e.code] !== undefined) { userKeys[capturing] = e.code; saveControls(); rebuildRemap(); }
    capturing = null; render();
  }, true);
  // Mouse buttons and sensitivity (controls.js): which action each button does in a mission, and a multiplier
  // on the mouse motion on top of the game's own sensitivity setting.
  const mouseHost = $('kbd-mouse');
  const renderMouse = () => {
    if (!mouseHost) return;
    const C = RcControls, s = C.get();
    const sel = (btn) => `<select data-btn="${btn}">` + C.MOUSE_CHOICES.map((a) =>
      `<option value="${a}"${s.mouse[btn] === a ? ' selected' : ''}>${C.ACTIONS[a].label}</option>`).join('') + '</select>';
    mouseHost.innerHTML = '<h3>Mouse</h3>' +
      `<div class="row"><span class="label">Left</span>${sel(0)}</div>` +
      `<div class="row"><span class="label">Right</span>${sel(2)}</div>` +
      `<div class="row"><span class="label">Middle</span>${sel(1)}</div>` +
      '<div class="row"><span class="label">Scroll</span><div class="keys">next / prev weapon</div></div>' +
      `<div class="row"><span class="label">Sensitivity</span><output data-for="mouseSens">${s.mouseSens.toFixed(1)}×</output></div>` +
      `<input class="kbd-range" type="range" min="0.2" max="3" step="0.1" value="${s.mouseSens}" data-k="mouseSens" aria-label="Mouse sensitivity">` +
      `<div class="row"><span class="label">Scoped</span><output data-for="scopeSens">${s.scopeSens.toFixed(1)}×</output></div>` +
      `<input class="kbd-range" type="range" min="0.3" max="3" step="0.1" value="${s.scopeSens}" data-k="scopeSens" aria-label="Scoped sensitivity">` +
      '<p class="kbd-note">Scoped: while zoomed in (scope or binoculars), on top of the game\'s own slow-down by the zoom.</p>';
    mouseHost.querySelectorAll('select').forEach((e) => { e.onchange = () => RcControls.setMouse(Number(e.dataset.btn), e.value); });
    mouseHost.querySelectorAll('input[type=range]').forEach((range) => {
      range.oninput = () => { RcControls.set(range.dataset.k, Number(range.value)); mouseHost.querySelector(`output[data-for="${range.dataset.k}"]`).textContent = Number(range.value).toFixed(1) + '×'; };
    });
  };
  const reset = $('kbd-reset');
  if (reset) reset.onclick = () => {
    applyPreset(preset); capturing = null; render();
    RcControls.reset(); renderMouse();
    syncSettingButtons();
  };
  render();
  renderMouse();
}

function hookInput(M, net) {
  const canvas = $('canvas');
  if (net) {
    const key = (down) => (e) => {
      const bit = NET_KEYS[e.code];
      if (bit === undefined) return;
      e.preventDefault();
      if (down) { netKeyBits |= 1 << bit; netKeyPressed |= 1 << bit; } else netKeyBits &= ~(1 << bit);
      pollLocalPad(M);   // straight to the game: waiting for the next animation frame would add up to 16 ms
    };
    window.addEventListener('keydown', key(true));
    window.addEventListener('keyup', key(false));
    window.addEventListener('blur', () => { netKeyBits = 0; pollLocalPad(M); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    return;
  }
  const C = RcControls;
  C.attach(M);
  const key = (down) => (e) => {
    const u = keyRemap[e.code] !== undefined ? keyRemap[e.code] : HID[e.code];
    if (u === undefined || e.repeat) return;
    if (!(e.metaKey && !down)) e.preventDefault();
    C.keyUsage(u, down);   // a weapon key drops the scope state (controls.js)
    M._input_key_hid(u, down ? 1 : 0);
  };
  window.addEventListener('keydown', key(true));
  window.addEventListener('keyup', key(false));
  // The game draws its own cursor and reads relative motion. Lock the pointer when the browser allows
  // it (then the system cursor can't leave the game); without a lock, motion over the canvas still works.
  // Each button does the action the player bound to it (controls.js; the Controls panel): in a mission
  // only, the menus always get the plain click. The action a press started is what its release ends, even
  // if the binding or the mission state changed in between.
  const held = {};
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) {
      const p = canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
    }
    if (held[e.button]) C.act(held[e.button], false);
    held[e.button] = C.mouseAction(e.button);
    C.act(held[e.button], true);
  });
  window.addEventListener('mouseup', (e) => { if (held[e.button]) { C.act(held[e.button], false); held[e.button] = null; } });
  // Relative motion, scaled by the mouse sensitivity setting in a mission (fractions carry over, so 1 = the
  // raw counts as before). The engine (dinput.c) inverts look-Y only during a mission, so the 2D menus keep
  // their normal cursor direction.
  canvas.addEventListener('mousemove', (e) => {
    if (!C.inMission()) { M._input_mouse_move(e.movementX, e.movementY); return; }
    const k = C.get().mouseSens * C.lookScale();   // slower while scoped, in step with the zoom
    C.look(e.movementX * k, e.movementY * k);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Mouse wheel cycles weapons: up = next (the game's right-click), down = previous (its O key). A short
  // lock keeps a fast flick from stacking presses; each is held ~100 ms so a game frame samples it.
  let wheelLock = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelLock = now + 140;
    C.weaponChanged();
    if (e.deltaY < 0) { M._input_mouse_button(1, 1); setTimeout(() => M._input_mouse_button(1, 0), 100); }
    else { M._input_key_hid(18, 1); setTimeout(() => M._input_key_hid(18, 0), 100); }
  }, { passive: false });
}

// Gamepads (Gamepad API, polled every animation frame). Browsers only expose a pad after a button press
// on it. The game sees each pad as a DirectInput "Logitech Dual Action USB" (host/dinput.c); ?pads=N exposes
// N of them (default 1, at most 4). Like the native feeder (host/window.c), slots are DirectInput pad
// numbers handed out in connection order, not the browser's gamepad.index (which can start above 0, e.g.
// after a reconnect), and a pad keeps its slot until it is unplugged.
// With mapping 'standard' buttons and axes are already in the layout input_gamepad() takes. Other pads
// (older DirectInput-era ones such as the Logitech Precision) report buttons in HID order, as Windows
// DirectInput presents them and as the game's controltypes.csv expects; their axes are indexed by HID
// usage (X Y Z Rx Ry Rz ...), so the right stick is Z/Rz and Chrome puts the hat switch at axes[9].
const PAD_SLOTS = 4;
const padLast = Array.from({ length: PAD_SLOTS }, () => '');
const padSlotIndex = Array(PAD_SLOTS).fill(-1);   // slot -> gamepad.index
const padHats = new Set();   // gamepad.index of pads whose axes[9] is a hat switch
// raw button n -> standard-layout bit that host/dinput.c turns back into DirectInput button n
const STD_FOR_RAW = [2, 0, 1, 3, 4, 5, 6, 7, 9, 8, 10, 11];
// Chrome's hat axis: -1 = up, then clockwise in steps of 2/7; anything outside [-1, 1] is centred
const HAT_DIRS = [1 << 12, (1 << 12) | (1 << 15), 1 << 15, (1 << 13) | (1 << 15), 1 << 13, (1 << 13) | (1 << 14), 1 << 14, (1 << 12) | (1 << 14)];
const axis16 = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 32767);

function readPad(g) {
  let buttons = 0;
  if (g.mapping === 'standard') {
    g.buttons.forEach((b, i) => { if (i < 17 && (b.pressed || b.value > 0.3)) buttons |= 1 << i; });
    return { buttons, ax: [0, 1, 2, 3].map((i) => axis16(g.axes[i])) };
  }
  g.buttons.forEach((b, i) => { if (i < STD_FOR_RAW.length && (b.pressed || b.value > 0.3)) buttons |= 1 << STD_FOR_RAW[i]; });
  // axes[9] is only taken as a hat once it has shown the centred value, so a plain axis resting at 0 isn't
  // read as d-pad down
  const hat = g.axes[9];
  if (hat > 1.1) padHats.add(g.index);
  else if (padHats.has(g.index) && hat >= -1.01) buttons |= HAT_DIRS[Math.round((hat + 1) * 3.5) % 8];
  const ry = g.axes.length > 5 ? g.axes[5] : g.axes[3];
  return { buttons, ax: [axis16(g.axes[0]), axis16(g.axes[1]), axis16(g.axes[2]), axis16(ry)] };
}

// Netplay: one local pad, the first connected gamepad merged with the keyboard (host/netplay.c sends it).
// Called from the key handlers and from a 1 ms timer (not just the animation frame), so a change reaches
// the game thread within a few ms wherever it is in its frame.
let netLast = '';
function pollLocalPad(M) {
  const g = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((p) => p && p.connected);
  const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
  const b = buttons | netKeyBits | netKeyPressed;
  netKeyPressed = 0;
  const key = `${b}:${ax.join(',')}`;
  if (key === netLast) return;
  netLast = key;
  M._input_gamepad(0, 1, b, ax[0], ax[1], ax[2], ax[3]);
}

function pollGamepads(M) {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
  // free the slots of unplugged pads, then give new pads the lowest free slot
  for (let s = 0; s < PAD_SLOTS; s++)
    if (padSlotIndex[s] >= 0 && !pads.some((g) => g.index === padSlotIndex[s])) { padHats.delete(padSlotIndex[s]); padSlotIndex[s] = -1; }
  for (const g of pads) {
    if (padSlotIndex.includes(g.index)) continue;
    const s = padSlotIndex.indexOf(-1);
    if (s < 0) break;
    padSlotIndex[s] = g.index;
    console.log(`gamepad ${g.index} -> pad ${s}: ${g.id} (${g.mapping || 'non-standard'} mapping, ${g.buttons.length} buttons, ${g.axes.length} axes)`);
  }
  for (let slot = 0; slot < PAD_SLOTS; slot++) {
    const g = pads.find((p) => p.index === padSlotIndex[slot]);
    const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
    const connected = g ? 1 : 0;
    const key = `${connected}:${buttons}:${ax.join(',')}`;
    if (key === padLast[slot]) continue;
    padLast[slot] = key;
    M._input_gamepad(slot, connected, buttons, ax[0], ax[1], ax[2], ax[3]);
  }
}

// ------------------------------------------------------------------ audio

let audioMasterGain = null;
function setAudioMuted(muted) {
  try { localStorage.setItem('rc-audio-enabled', muted ? '0' : '1'); } catch {}
  if (audioMasterGain) {
    audioMasterGain.gain.setValueAtTime(muted ? 0 : 1, audioMasterGain.context.currentTime);
  }
}
function isAudioMuted() {
  try { return localStorage.getItem('rc-audio-enabled') === '0'; } catch { return false; }
}

// Create the audio context synchronously at launch. A manual Play click can unlock it immediately;
// autoplay waits for the player's first ordinary interaction with the game surface.
function newAudioContext() {
  if (params.has('mute') || !window.AudioContext) return null;
  try { return new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' }); } catch { return null; }
}

async function startAudio(M, ctx) {
  if (!ctx) return;
  if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'rc-ring', { outputChannelCount: [2] });
  node.port.postMessage({ memory: M.wasmMemory, ring: M._rc_audio_ring() });
  audioMasterGain = ctx.createGain();
  audioMasterGain.gain.value = isAudioMuted() ? 0 : 1;
  node.connect(audioMasterGain);
  audioMasterGain.connect(ctx.destination);
}

// ------------------------------------------------------------------ run

const isWebKit = () => /AppleWebKit\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
function compactMemory() {
  const want = params.get('mem');
  return want === 'compact' || (want !== 'full' && isWebKit());
}

// The browser dropped the WebGPU device (its GPU process died, or the page was pushed out of memory): the
// game can't draw any more (render_wgpu.c calls this). Say so instead of leaving a frozen picture.
window.rcDeviceLost = (msg) => {
  if ($('gpulost')) return;
  const d = document.createElement('div');
  d.id = 'gpulost';
  d.style.cssText = 'position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(0,0,0,.92);color:#fff;' +
    'font:16px/1.5 inherit;text-align:center;padding:24px';
  d.innerHTML = '<div><p style="font-size:20px;margin:0 0 8px">The graphics device was lost</p>' +
    '<p style="opacity:.8;margin:0 0 18px">The browser stopped the game\'s renderer' + (msg ? ' (' + msg.replace(/[<>&]/g, '') + ')' : '') +
    '. Your progress since the last save is lost.</p>' +
    '<button id="gpulost-reload" style="font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#45cf79;color:#000;font-weight:700">Reload the game</button></div>';
  document.body.appendChild(d);
  $('gpulost-reload').onclick = () => location.reload();
};

function sizeCanvas() {
  const canvas = $('canvas');
  const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(640, Math.round(r.width * dpr));
  canvas.height = Math.max(480, Math.round(r.height * dpr));
}

// On a phone the stage is fixed to the viewport (index.html: body.coarse #stage). If the page ends up zoomed
// or scrolled (iOS does that around rotation and fullscreen, Android when the browser's zoom setting is on),
// a fixed box is laid out to the layout viewport and overflows the screen: the picture is cropped and the
// touch controls land off-screen. Size and place the stage on the VISUAL viewport instead whenever the two
// differ; with no zoom and no offset this sets exactly the box the stylesheet gives it.
function followVisualViewport(stage) {
  const vv = window.visualViewport;
  if (!vv) return;
  let applied = false;
  const apply = () => {
    const zoomed = Math.abs(vv.scale - 1) > 0.01 || vv.offsetLeft > 0.5 || vv.offsetTop > 0.5 ||
      Math.abs(vv.width - innerWidth) > 1 || Math.abs(vv.height - innerHeight) > 1;
    if (!zoomed && !applied) return;
    applied = zoomed;
    if (!zoomed) { stage.style.cssText = ''; return; }
    stage.style.cssText = `position:fixed;inset:auto;left:${vv.offsetLeft}px;top:${vv.offsetTop}px;width:${vv.width}px;` +
      `height:${vv.height}px;aspect-ratio:auto;border-radius:0;box-shadow:none`;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  apply();
}

// A netplay session: every peer starts from the same empty saves folder, kept apart from this browser's
// normal saves (one per player slot, so two tabs of one browser can play each other).
const netSaves = (session) => `rcnetplay-${session.you}`;
async function clearNetSaves(session) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(netSaves(session), { recursive: true }); } catch { /* not there yet */ }
}

function showNetStatus(M, session) {
  const el = $('netstatus');
  el.classList.remove('hidden');
  let lastFrame = 0, lastT = performance.now();
  setInterval(() => {
    const frame = M._netplay_status(0), desync = M._netplay_status(2), stalls = M._netplay_status(3);
    const now = performance.now();
    // the game thread always idles until the next frame's inputs arrive; it's only "waiting" when that
    // holds the game below full speed
    const fps = ((frame - lastFrame) * 1000) / Math.max(1, now - lastT);
    lastFrame = frame; lastT = now;
    el.classList.toggle('bad', !!desync);
    // the round trip the inputs ride on, and how many frames the delay failed to cover (a stall is a
    // frame that waited over 10 ms for the others' inputs: the game froze that long)
    const trips = session.client.trips();
    const path = trips.direct ? `direct ${trips.direct} ms` : `relayed ${trips.room} ms`;
    el.textContent = desync ? `Out of sync since frame ${desync}: restart the session`
      : `Online · player ${session.you + 1} of ${session.players} · delay ${session.delay}` +
        ` · ${path}` + (stalls ? ` · ${stalls} stalls` : '') +
        (session.reconnecting ? ' · reconnecting…' : frame > 300 && fps < 50 ? ' · waiting for players' : '') +
        (session.left?.size ? ` · ${session.left.size} left` : '');
  }, 1000);
}

const CONFIG_DEFAULT_B64 = "TE9PUAgAAAAFAAAAPAAAAGwBAAAwAQAAOwMAAKcEAACzBAAADAAAACwAAADfBAAA9AQAAAAAAAAAAAAAAAAAAAgAAAAbAAAAJAAAADQAAAA/AAAASwAAAFUAAABeAAAAeAAAAIEAAACLAAAAlQAAAJwAAACjAAAArAAAALUAAAC6AAAA0QAAAOAAAADnAAAA8gAAAPsAAAALAQAAEgEAACEBAAAmAQAAMgEAAD0BAABMAQAAVwEAAF0BAABrAQAAeQEAAH4BAACKAQAAlQEAAJ8BAACrAQAAsQEAAL8BAADFAQAAzAEAANcBAADfAQAA7AEAAPwBAAACAgAAEgIAABgCAAAoAgAALgIAAD4CAABEAgAAVAIAAFoCAABqAgAAcAIAAIACAACGAgAAlgIAAJwCAACsAgAAsgIAALwCAADIAgAA0wIAAOQCAADvAgAA9wIAAAIDAAAHAwAAEQMAABYDAAAkAwAAMQMAAEdPU3RhcnQAR09Db250ZW50Q29udHJvbFBXAEdPUGxheWVyAEdPQWN0aXZlTWlzc2lvbgBHT0luTW91SW52AEdPSW5Nb3VTZW5zAEdPSW5SZW1hcABNb3ZlTGVmdABJTlBVVFBPUlRfREVWSUNFX0tFWUJPQVJEAEtFWV9MRUZUAE1vdmVSaWdodABLRVlfUklHSFQATW92ZVVwAEtFWV9VUABNb3ZlRG93bgBLRVlfRE9XTgBGaXJlAElOUFVUUE9SVF9ERVZJQ0VfTU9VU0UATU9VU0VfQlVUVE9OXzEAUmVsb2FkAEtFWV9SRVRVUk4AQWN0aXZhdGUAS0VZX1JJR0hUX1NISUZUAENyb3VjaABLRVlfUklHSFRfQ1RSTABKdW1wAEtFWV9OVU1QQUQwAE5leHRXZWFwb24ATU9VU0VfQlVUVE9OXzIAUHJldldlYXBvbgBLRVlfTwBBbHRlcm5hdGVGaXJlAEtFWV9CQUNLU1BBQ0UAUGVlawBLRVlfTlVNUEFEMQBCaW5vY3VsYXJzAEtFWV9TUEFDRQBNYXBDb21wdXRlcgBLRVlfQwBUb2dnbGVXYWxrUnVuAEtFWV9XAFpvb21JbgBLRVlfUEFHRVVQAFpvb21PdXQAS0VZX1BBR0VET1dOAFdlYXBvbkNhdGVnb3J5MQBLRVlfMQBXZWFwb25DYXRlZ29yeTIAS0VZXzIAV2VhcG9uQ2F0ZWdvcnkzAEtFWV8zAFdlYXBvbkNhdGVnb3J5NABLRVlfNABXZWFwb25DYXRlZ29yeTUAS0VZXzUAV2VhcG9uQ2F0ZWdvcnk2AEtFWV82AFdlYXBvbkNhdGVnb3J5NwBLRVlfNwBXZWFwb25DYXRlZ29yeTgAS0VZXzgAV2VhcG9uQ2F0ZWdvcnk5AEtFWV85AEdPR2Z4RGlzcABHT0dmeERldmljZQBHT0dmeEdhbW1hAEdPR2Z4UGVyZm9ybWFuY2UAR09HYW1lTGFuZwBFTkdMSVNIAEdPR2FtZURpZmYAR0RfMgBHT0lzQmxvb2QAVFJVRQBHT1NvdW5kU3BlZWNoAEdPU291bmRNdXNpYwBHT1NvdW5kRlgAAAAAAAEAAAAFAAAAAEpvZQB7MDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwfQANABgBAAAAEAAAABQCAAAADwASDQEYAQAAACMAAAAUAwAAAAkAABINAhgBAAAANwAAABQDAAAACQEAEg0DGAEAAABLAAAAFAIAAAAQABINBBgBAAAAXgAAABQCAAAADwASDQUYAQAAAHEAAAAUBgAAAAXMzMw+ABINBhgDAAAAkAAAAJMAAACWAAAAFAkAAAANBwANCAANCQASDQYYAwAAALIAAAC1AAAAuAAAABQJAAAADQoADQgADQsAEg0GGAMAAADUAAAA1wAAANoAAAAUCQAAAA0MAA0IAA0NABINBhgDAAAA9gAAAPkAAAD8AAAAFAkAAAANDgANCAANDwASDQYYAwAAABgBAAAbAQAAHgEAABQJAAAADRAADREADRIAEg0GGAMAAAA6AQAAPQEAAEABAAAUCQAAAA0TAA0IAA0UABINBhgDAAAAXAEAAF8BAABiAQAAFAkAAAANFQANCAANFgASDQYYAwAAAH4BAACBAQAAhAEAABQJAAAADRcADQgADRgAEg0GGAMAAACgAQAAowEAAKYBAAAUCQAAAA0ZAA0IAA0aABINBhgDAAAAwgEAAMUBAADIAQAAFAkAAAANGwANEQANHAASDQYYAwAAAOQBAADnAQAA6gEAABQJAAAADR0ADQgADR4AEg0GGAMAAAAGAgAACQIAAAwCAAAUCQAAAA0fAA0IAA0gABINBhgDAAAAKAIAACsCAAAuAgAAFAkAAAANIQANCAANIgASDQYYAwAAAEoCAABNAgAAUAIAABQJAAAADSMADQgADSQAEg0GGAMAAABsAgAAbwIAAHICAAAUCQAAAA0lAA0IAA0mABINBhgDAAAAjgIAAJECAACUAgAAFAkAAAANJwANCAANKAASDQYYAwAAALACAACzAgAAtgIAABQJAAAADSkADQgADSoAEg0GGAMAAADSAgAA1QIAANgCAAAUCQAAAA0rAA0IAA0sABINBhgDAAAA9AIAAPcCAAD6AgAAFAkAAAANLQANCAANLgASDQYYAwAAABYDAAAZAwAAHAMAABQJAAAADS8ADQgADTAAEg0GGAMAAAA4AwAAOwMAAD4DAAAUCQAAAA0xAA0IAA0yABINBhgDAAAAWgMAAF0DAABgAwAAFAkAAAANMwANCAANNAASDQYYAwAAAHwDAAB/AwAAggMAABQJAAAADTUADQgADTYAEg0GGAMAAACeAwAAoQMAAKQDAAAUCQAAAA03AA0IAA04ABINBhgDAAAAwAMAAMMDAADGAwAAFAkAAAANOQANCAANOgASDQYYAwAAAOIDAADlAwAA6AMAABQJAAAADTsADQgADTwAEg0GGAMAAAAEBAAABwQAAAoEAAAUCQAAAA09AA0IAA0+ABINPxgDAAAAJgQAACoEAAAuBAAAFAsAAAAEAAQABAADAAMgABINQBgBAAAAQgQAABQDAAAACQIAEg1BGAEAAABWBAAAFAIAAAAQABINQhgBAAAAaQQAABQCAAAADwASDUMYAQAAAHwEAAAUAwAAAA1EABINRRgBAAAAkAQAABQDAAAADUYAEg1HGAEAAACkBAAAFAMAAAANSAASDUkYAgAAALwEAAC+BAAAFAQAAAAQABAAEg1KGAIAAADVBAAA1wQAABQEAAAAEAAQABINSxgCAAAA7gQAAPAEAAAUBAAAABAAEAASAA==";
const CONFIG_100_B64 = "TE9PUAgAAAAFAAAAPAAAAHABAAA0AQAAQAMAALAEAADABAAAEAAAADgAAAD4BAAAwgkAAAAAAAAAAAAAAAAAAAgAAAAbAAAAJAAAADQAAAA/AAAASwAAAFUAAABeAAAAeAAAAIEAAACLAAAAlQAAAJwAAACjAAAArAAAALUAAAC6AAAA0QAAAOAAAADnAAAA8gAAAPsAAAALAQAAEgEAACEBAAAmAQAAMgEAAD0BAABMAQAAVwEAAF0BAABrAQAAeQEAAH4BAACKAQAAlQEAAJ8BAACrAQAAsQEAAL8BAADFAQAAzAEAANcBAADfAQAA7AEAAPwBAAACAgAAEgIAABgCAAAoAgAALgIAAD4CAABEAgAAVAIAAFoCAABqAgAAcAIAAIACAACGAgAAlgIAAJwCAACsAgAAsgIAALwCAADIAgAA0wIAAOQCAADvAgAA9wIAAAIDAAAHAwAAEQMAABYDAAAkAwAAMQMAADsDAABHT1N0YXJ0AEdPQ29udGVudENvbnRyb2xQVwBHT1BsYXllcgBHT0FjdGl2ZU1pc3Npb24AR09Jbk1vdUludgBHT0luTW91U2VucwBHT0luUmVtYXAATW92ZUxlZnQASU5QVVRQT1JUX0RFVklDRV9LRVlCT0FSRABLRVlfTEVGVABNb3ZlUmlnaHQAS0VZX1JJR0hUAE1vdmVVcABLRVlfVVAATW92ZURvd24AS0VZX0RPV04ARmlyZQBJTlBVVFBPUlRfREVWSUNFX01PVVNFAE1PVVNFX0JVVFRPTl8xAFJlbG9hZABLRVlfUkVUVVJOAEFjdGl2YXRlAEtFWV9SSUdIVF9TSElGVABDcm91Y2gAS0VZX1JJR0hUX0NUUkwASnVtcABLRVlfTlVNUEFEMABOZXh0V2VhcG9uAE1PVVNFX0JVVFRPTl8yAFByZXZXZWFwb24AS0VZX08AQWx0ZXJuYXRlRmlyZQBLRVlfQkFDS1NQQUNFAFBlZWsAS0VZX05VTVBBRDEAQmlub2N1bGFycwBLRVlfU1BBQ0UATWFwQ29tcHV0ZXIAS0VZX0MAVG9nZ2xlV2Fsa1J1bgBLRVlfVwBab29tSW4AS0VZX1BBR0VVUABab29tT3V0AEtFWV9QQUdFRE9XTgBXZWFwb25DYXRlZ29yeTEAS0VZXzEAV2VhcG9uQ2F0ZWdvcnkyAEtFWV8yAFdlYXBvbkNhdGVnb3J5MwBLRVlfMwBXZWFwb25DYXRlZ29yeTQAS0VZXzQAV2VhcG9uQ2F0ZWdvcnk1AEtFWV81AFdlYXBvbkNhdGVnb3J5NgBLRVlfNgBXZWFwb25DYXRlZ29yeTcAS0VZXzcAV2VhcG9uQ2F0ZWdvcnk4AEtFWV84AFdlYXBvbkNhdGVnb3J5OQBLRVlfOQBHT0dmeERpc3AAR09HZnhEZXZpY2UAR09HZnhHYW1tYQBHT0dmeFBlcmZvcm1hbmNlAEdPR2FtZUxhbmcARU5HTElTSABHT0dhbWVEaWZmAEdEXzIAR09Jc0Jsb29kAFRSVUUAR09Tb3VuZFNwZWVjaABHT1NvdW5kTXVzaWMAR09Tb3VuZEZYAEdEXzEAAAAAAAEAAAAFAAAALAAAAABKb2UAezAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMH0ASm9lAAAAAAAAAAAADQAYAQAAABAAAAAUAgAAABAAEg0BGAEAAAAjAAAAFAMAAAAJAAASDQIYAQAAADcAAAAUAwAAAAkBABINAxgBAAAASwAAABQDAAAAAyAAEg0EGAEAAABfAAAAFAIAAAAPABINBRgBAAAAcgAAABQGAAAABczMzD4AEg0GGAMAAACRAAAAlAAAAJcAAAAUCQAAAA0HAA0IAA0JABINBhgDAAAAswAAALYAAAC5AAAAFAkAAAANCgANCAANCwASDQYYAwAAANUAAADYAAAA2wAAABQJAAAADQwADQgADQ0AEg0GGAMAAAD3AAAA+gAAAP0AAAAUCQAAAA0OAA0IAA0PABINBhgDAAAAGQEAABwBAAAfAQAAFAkAAAANEAANEQANEgASDQYYAwAAADsBAAA+AQAAQQEAABQJAAAADRMADQgADRQAEg0GGAMAAABdAQAAYAEAAGMBAAAUCQAAAA0VAA0IAA0WABINBhgDAAAAfwEAAIIBAACFAQAAFAkAAAANFwANCAANGAASDQYYAwAAAKEBAACkAQAApwEAABQJAAAADRkADQgADRoAEg0GGAMAAADDAQAAxgEAAMkBAAAUCQAAAA0bAA0RAA0cABINBhgDAAAA5QEAAOgBAADrAQAAFAkAAAANHQANCAANHgASDQYYAwAAAAcCAAAKAgAADQIAABQJAAAADR8ADQgADSAAEg0GGAMAAAApAgAALAIAAC8CAAAUCQAAAA0hAA0IAA0iABINBhgDAAAASwIAAE4CAABRAgAAFAkAAAANIwANCAANJAASDQYYAwAAAG0CAABwAgAAcwIAABQJAAAADSUADQgADSYAEg0GGAMAAACPAgAAkgIAAJUCAAAUCQAAAA0nAA0IAA0oABINBhgDAAAAsQIAALQCAAC3AgAAFAkAAAANKQANCAANKgASDQYYAwAAANMCAADWAgAA2QIAABQJAAAADSsADQgADSwAEg0GGAMAAAD1AgAA+AIAAPsCAAAUCQAAAA0tAA0IAA0uABINBhgDAAAAFwMAABoDAAAdAwAAFAkAAAANLwANCAANMAASDQYYAwAAADkDAAA8AwAAPwMAABQJAAAADTEADQgADTIAEg0GGAMAAABbAwAAXgMAAGEDAAAUCQAAAA0zAA0IAA00ABINBhgDAAAAfQMAAIADAACDAwAAFAkAAAANNQANCAANNgASDQYYAwAAAJ8DAACiAwAApQMAABQJAAAADTcADQgADTgAEg0GGAMAAADBAwAAxAMAAMcDAAAUCQAAAA05AA0IAA06ABINBhgDAAAA4wMAAOYDAADpAwAAFAkAAAANOwANCAANPAASDQYYAwAAAAUEAAAIBAAACwQAABQJAAAADT0ADQgADT4AEg0/GAMAAAAnBAAAKwQAAC8EAAAUCwAAAAQABAAEAAMAAxAAEg1AGAEAAABDBAAAFAMAAAAJAgASDUEYAQAAAFcEAAAUAgAAABAAEg1CGAEAAABqBAAAFAIAAAAPABINQxgBAAAAfQQAABQDAAAADUQAEg1FGAEAAACRBAAAFAMAAAANRgASDUcYAQAAAKUEAAAUAwAAAA1IABINSRgCAAAAvQQAAL8EAAAUBAAAABAAEAASDUoYAgAAANYEAADYBAAAFAQAAAAQABAAEg1LGAIAAADvBAAA8QQAABQEAAAAEAAQABINAhgBAAAABAUAABQDAAAACQMAEg0DGAEAAAAYBQAAFAMAAAADDQASDQQYAQAAACwFAAAUAgAAAA8AEg0FGAEAAAA/BQAAFAYAAAAFmZmZPgASDQYYAwAAAF4FAABhBQAAZAUAABQJAAAADQcADQgADQkAEg0GGAMAAACABQAAgwUAAIYFAAAUCQAAAA0KAA0IAA0LABINBhgDAAAAogUAAKUFAACoBQAAFAkAAAANDAANCAANDQASDQYYAwAAAMQFAADHBQAAygUAABQJAAAADQ4ADQgADQ8AEg0GGAMAAADmBQAA6QUAAOwFAAAUCQAAAA0QAA0RAA0SABINBhgDAAAACAYAAAsGAAAOBgAAFAkAAAANEwANCAANFAASDQYYAwAAACoGAAAtBgAAMAYAABQJAAAADRUADQgADRYAEg0GGAMAAABMBgAATwYAAFIGAAAUCQAAAA0XAA0IAA0YABINBhgDAAAAbgYAAHEGAAB0BgAAFAkAAAANGQANCAANGgASDQYYAwAAAJAGAACTBgAAlgYAABQJAAAADRsADREADRwAEg0GGAMAAACyBgAAtQYAALgGAAAUCQAAAA0dAA0IAA0eABINBhgDAAAA1AYAANcGAADaBgAAFAkAAAANHwANCAANIAASDQYYAwAAAPYGAAD5BgAA/AYAABQJAAAADSEADQgADSIAEg0GGAMAAAAYBwAAGwcAAB4HAAAUCQAAAA0jAA0IAA0kABINBhgDAAAAOgcAAD0HAABABwAAFAkAAAANJQANCAANJgASDQYYAwAAAFwHAABfBwAAYgcAABQJAAAADScADQgADSgAEg0GGAMAAAB+BwAAgQcAAIQHAAAUCQAAAA0pAA0IAA0qABINBhgDAAAAoAcAAKMHAACmBwAAFAkAAAANKwANCAANLAASDQYYAwAAAMIHAADFBwAAyAcAABQJAAAADS0ADQgADS4AEg0GGAMAAADkBwAA5wcAAOoHAAAUCQAAAA0vAA0IAA0wABINBhgDAAAABggAAAkIAAAMCAAAFAkAAAANMQANCAANMgASDQYYAwAAACgIAAArCAAALggAABQJAAAADTMADQgADTQAEg0GGAMAAABKCAAATQgAAFAIAAAUCQAAAA01AA0IAA02ABINBhgDAAAAbAgAAG8IAAByCAAAFAkAAAANNwANCAANOAASDQYYAwAAAI4IAACRCAAAlAgAABQJAAAADTkADQgADToAEg0GGAMAAACwCAAAswgAALYIAAAUCQAAAA07AA0IAA08ABINBhgDAAAA0ggAANUIAADYCAAAFAkAAAANPQANCAANPgASDT8YAwAAAPQIAAD4CAAA/AgAABQLAAAABAAEAAQAAwADEAASDUAYAQAAABAJAAAUAwAAAAkCABINQRgBAAAAJAkAABQCAAAAEAASDUIYAQAAADcJAAAUAgAAAA8AEg1DGAEAAABKCQAAFAMAAAANRAASDUUYAQAAAF4JAAAUAwAAAA1MABINRxgBAAAAcgkAABQDAAAADUgAEg1JGAIAAACKCQAAjAkAABQEAAAAEAAQABINShgCAAAAowkAAKUJAAAUBAAAABAAEAASDUsYAgAAALwJAAC+CQAAFAQAAAAQABAAEgA=";

function b64ToUint8Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function writeOpfsConfig(bytes) {
  const gDir = await gameDir(false);
  const cfh = await gDir.getFileHandle('config.qvm', { create: true });
  const cw = await cfh.createWritable();
  await cw.write(bytes);
  await cw.close();
}

function showStatus(text, type = 'info') {
  const sMsg = $('status-msg');
  if (sMsg) {
    sMsg.textContent = text;
    sMsg.className = 'status-msg' + (type === 'success' ? ' success' : type === 'error' ? ' error' : '');
    sMsg.style.opacity = '1';
  }
}

function notifyProgress(msg, isSuccess = true) {
  showStatus(msg, isSuccess ? 'success' : 'error');
}

async function setMissionProgress(type) {
  try {
    const bytes = (type === '100') ? b64ToUint8Array(CONFIG_100_B64) : b64ToUint8Array(CONFIG_DEFAULT_B64);
    await writeOpfsConfig(bytes);
    const msg = type === '100' ? '✓ All 14 missions unlocked (Profile: Joe)!' : '✓ Reset to Mission 1 (Trainyard). Game files preserved.';
    notifyProgress(msg, true);
  } catch (err) {
    console.error('Failed to update config.qvm:', err);
    notifyProgress('Save update error: ' + err.message, false);
  }
}

let modalConfirmAction = null;
function showModal({ title, text, warning, confirmText, confirmClass, onConfirm }) {
  const overlay = $('modal-overlay');
  if (!overlay) return;
  if ($('modal-title')) $('modal-title').textContent = title;
  if ($('modal-text')) $('modal-text').textContent = text;
  if ($('modal-warning')) $('modal-warning').textContent = warning;
  const cBtn = $('btn-modal-confirm');
  if (cBtn) {
    cBtn.textContent = confirmText || 'CONFIRM';
    cBtn.className = 'action-btn ' + (confirmClass || 'btn-red');
  }
  modalConfirmAction = onConfirm;
  overlay.style.display = 'flex';
}

function hideModal() {
  const overlay = $('modal-overlay');
  if (overlay) overlay.style.display = 'none';
  modalConfirmAction = null;
}

function openSettings() {
  syncSettingButtons();
  if (document.pointerLockElement) document.exitPointerLock?.();
  const overlay = $('settings-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay) overlay.style.display = 'none';
  if (document.body.classList.contains('playing')) {
    $('canvas')?.focus();
  }
}

function syncSettingButtons() {
  const C = RcControls.get();
  // Keyboard Layout Preset
  document.querySelectorAll('#opt-preset-group .opt-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });
  const noteEl = $('setting-preset-note');
  if (noteEl) {
    noteEl.textContent = preset === 'original'
      ? 'The keys the game ships with. Click any key below to change it.'
      : 'WASD, Shift walk, Ctrl crouch, Space jump, R reload. Click any key below to change it.';
  }
    // Screen Display (Widescreen)
  document.querySelectorAll('#opt-wide-group .opt-btn').forEach((b) => {
    b.classList.toggle('active', (b.dataset.wide === '1') === C.wide);
  });
  // Control Type (Device)
  const isTouch = RcTouch.wanted();
  document.querySelectorAll('#opt-device-group .opt-btn').forEach((b) => {
    const isT = b.dataset.device === 'touch';
    b.classList.toggle('active', isT === isTouch);
  });
  // Audio
  const muted = isAudioMuted();
  document.querySelectorAll('#opt-sound-group .opt-btn').forEach((b) => {
    const isEnabled = b.dataset.sound === '1';
    b.classList.toggle('active', isEnabled === !muted);
  });
  // Mouse Dropdowns
  const m0 = $('setting-mouse-0');
  const m1 = $('setting-mouse-1');
  const m2 = $('setting-mouse-2');
  if (m0) m0.value = C.mouse[0] || 'fire';
  if (m1) m1.value = C.mouse[1] || 'altfire';
  if (m2) m2.value = C.mouse[2] || 'scope';
  // Sensitivity Sliders
  const sensRange = $('setting-sens-range');
  const sensVal = $('setting-sens-val');
  if (sensRange) sensRange.value = C.mouseSens;
  if (sensVal) sensVal.textContent = C.mouseSens.toFixed(1) + '×';

  const scopedSensRange = $('setting-scoped-sens-range');
  const scopedSensVal = $('setting-scoped-sens-val');
  if (scopedSensRange) scopedSensRange.value = C.scopeSens;
  if (scopedSensVal) scopedSensVal.textContent = C.scopeSens.toFixed(1) + '×';
}

function setupUIWiring() {
  const btnPlay = $('btn-play-game');
  if (btnPlay) btnPlay.onclick = () => followGate(() => run().catch(fail));

  const btnSettings = $('btn-settings-game');
  if (btnSettings) btnSettings.onclick = openSettings;

  const btnSettingsClose = $('btn-settings-close');
  if (btnSettingsClose) btnSettingsClose.onclick = closeSettings;

  const kbdShow = $('kbd-show');
  if (kbdShow) kbdShow.onclick = openSettings;

  const btnMod = $('btn-mod-game');
  if (btnMod) {
    btnMod.onclick = () => {
      showModal({
        title: 'UNLOCK ALL MISSIONS',
        text: 'Unlock all 14 campaign missions and set completed status (Profile: Joe)?',
        warning: '⚠️ Note: Your current mission progress will be replaced with a 100% completed save.',
        confirmText: 'UNLOCK ALL',
        confirmClass: 'btn-green',
        onConfirm: async () => {
          await setMissionProgress('100');
        }
      });
    };
  }

  const btnReset = $('btn-reset-game');
  if (btnReset) {
    btnReset.onclick = () => {
      showModal({
        title: 'RESET PROGRESS',
        text: 'Are you sure you want to reset your mission progress to Mission 1 (Trainyard)?',
        warning: '⚠️ Downloaded game files are preserved. Only your mission config/save is reset.',
        confirmText: 'RESET PROGRESS',
        confirmClass: 'btn-red',
        onConfirm: async () => {
          await setMissionProgress('default');
        }
      });
    };
  }

  const cancelModal = $('btn-modal-cancel');
  if (cancelModal) cancelModal.onclick = hideModal;

  const confirmModal = $('btn-modal-confirm');
  if (confirmModal) {
    confirmModal.onclick = () => {
      if (modalConfirmAction) modalConfirmAction();
      hideModal();
    };
  }

  const modalOverlay = $('modal-overlay');
  if (modalOverlay) {
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) hideModal();
    };
  }

  const settingsOverlay = $('settings-overlay');
  if (settingsOverlay) {
    settingsOverlay.onclick = (e) => {
      if (e.target === settingsOverlay) closeSettings();
    };
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsOverlay && settingsOverlay.style.display === 'flex') {
        closeSettings();
      }
      if (modalOverlay && modalOverlay.style.display === 'flex') {
        hideModal();
      }
    }
  });

  document.querySelectorAll('#opt-preset-group .opt-btn').forEach((b) => {
    b.onclick = () => {
      applyPreset(b.dataset.preset);
      if (setupControls.render) setupControls.render();
      syncSettingButtons();
    };
  });

  document.querySelectorAll('#opt-wide-group .opt-btn').forEach((b) => {
    b.onclick = () => {
      const isWide = b.dataset.wide === '1';
      RcControls.set('wide', isWide);
      COHORT.on.wide = isWide;
      syncSettingButtons();
    };
  });

  document.querySelectorAll('#opt-device-group .opt-btn').forEach((b) => {
    b.onclick = () => {
      try { localStorage.setItem('igi-device', b.dataset.device); } catch {}
      setupDevice();
      syncSettingButtons();
    };
  });

  document.querySelectorAll('#opt-sound-group .opt-btn').forEach((b) => {
    b.onclick = () => {
      setAudioMuted(b.dataset.sound === '0');
      syncSettingButtons();
    };
  });

  // Populate Mouse Dropdowns
  const C = RcControls;
  const optionsHtml = C.MOUSE_CHOICES.map((a) =>
    `<option value="${a}">${C.ACTIONS[a].label}</option>`
  ).join('');

  for (const [id, btnIdx] of [['setting-mouse-0', 0], ['setting-mouse-1', 1], ['setting-mouse-2', 2]]) {
    const el = $(id);
    if (el) {
      el.innerHTML = optionsHtml;
      el.onchange = () => {
        RcControls.setMouse(btnIdx, el.value);
      };
    }
  }

  const sensRange = $('setting-sens-range');
  if (sensRange) {
    sensRange.oninput = () => {
      const val = parseFloat(sensRange.value);
      RcControls.set('mouseSens', val);
      const sensVal = $('setting-sens-val');
      if (sensVal) sensVal.textContent = val.toFixed(1) + '×';
    };
  }

  const scopedSensRange = $('setting-scoped-sens-range');
  if (scopedSensRange) {
    scopedSensRange.oninput = () => {
      const val = parseFloat(scopedSensRange.value);
      RcControls.set('scopeSens', val);
      const scopedSensVal = $('setting-scoped-sens-val');
      if (scopedSensVal) scopedSensVal.textContent = val.toFixed(1) + '×';
    };
  }

  const btnFs = $('btn-toggle-fullscreen');
  if (btnFs) {
    btnFs.onclick = () => {
      const stage = $('stage');
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage)?.catch?.(() => {});
      }
    };
  }

  const kbdReset = $('kbd-reset');
  if (kbdReset) {
    kbdReset.onclick = () => {
      applyPreset(preset);
      RcControls.reset();
      syncSettingButtons();
      if (setupControls.render) setupControls.render();
    };
  }

  syncSettingButtons();
}

function applyNoCdPatch(u8) {
  if (u8.length >= 0x136410 && u8[0x2f6a] === 0x88 && u8[0x2f6b] === 0x5c) {
    u8.fill(0x90, 0x2f6a, 0x2f6a + 4);
    u8.fill(0x90, 0x2f74, 0x2f74 + 2);
    u8.fill(0x90, 0x2f80, 0x2f80 + 24);
    const enc = new TextEncoder();
    u8.set(enc.encode('.\\ymbe.afp\0'), 0x136328);
    u8.set(enc.encode('.\\mpzm.afp\0'), 0x136334);
    u8.set(enc.encode('.\\anys.afp\0'), 0x136340);
    u8.set(enc.encode('.\\dilj.afp\0'), 0x13634c);
    u8.set(enc.encode('.\\\0'), 0x136408);
    return true;
  }
  return false;
}

// One-time file preparation (NoCD patch, default config, AFP stubs).
// Called after the first download finishes, so the first PLAY click starts a
// clean game and is much less likely to trigger an immediate exit → page reload
// (which was the main reason users had to click PLAY twice the first time).
async function prepareGameFiles() {
  try {
    const gDir = await gameDir(false);
    let foundName = null;
    for await (const [name] of gDir.entries()) {
      if (name.toLowerCase() === 'igi.exe') foundName = name;
    }
    if (foundName) {
      const fh = await gDir.getFileHandle(foundName);
      const exeBuffer = await (await fh.getFile()).arrayBuffer();
      const u8 = new Uint8Array(exeBuffer);
      if (applyNoCdPatch(u8)) {
        for (const targetName of ['igi.exe', 'IGI.exe']) {
          const dstHandle = await gDir.getFileHandle(targetName, { create: true });
          const w = await dstHandle.createWritable();
          await w.write(u8);
          await w.close();
        }
      }
    }

    try {
      await gDir.getFileHandle('config.qvm');
    } catch {
      await writeOpfsConfig(b64ToUint8Array(CONFIG_DEFAULT_B64));
    }

    for (const afp of ['ymbe.afp', 'mpzm.afp', 'anys.afp', 'dilj.afp']) {
      try {
        await gDir.getFileHandle(afp);
      } catch {
        let foundUpper = null;
        for await (const [name] of gDir.entries()) {
          if (name.toLowerCase() === afp) { foundUpper = name; break; }
        }
        const dst = await gDir.getFileHandle(afp, { create: true });
        const w = await dst.createWritable();
        if (foundUpper) {
          const src = await (await gDir.getFileHandle(foundUpper)).getFile();
          await w.write(await src.arrayBuffer());
        } else {
          await w.write(new Uint8Array([0x3a]));
        }
        await w.close();
      }
    }
  } catch (e) {
    console.warn('prepareGameFiles error:', e);
  }
}

async function run(session) {
  const audio = newAudioContext();
  if (audio) {
    const resumeAudio = () => {
      if (audio.state !== 'running' && audio.state !== 'closed') audio.resume().catch(() => {});
    };
    const stage = $('stage');
    if (stage) {
      stage.addEventListener('pointerdown', resumeAudio, { passive: true });
      stage.addEventListener('keydown', resumeAudio);
    }
    resumeAudio();
  }
  const touch = !session && RcTouch.wanted();
  if (touch) RcTouch.goFullscreen($('stage'));   // also needs the gesture
  $('panel').classList.add('hidden');
  document.body.classList.add('playing');   // enables the touch re-fullscreen pill (index.html)
  showBoot();   // cover the black canvas until the first frame renders (see frame loop below)
  if (touch) {
    // touch device running
  } else { fullscreenTip(); controlsTip(); }
  if (session) await clearNetSaves(session);
  sizeCanvas();
  const script = document.createElement('script');
  script.src = 'build/recomp.js?v=10';
  await new Promise((ok, fail) => { script.onload = ok; script.onerror = fail; document.head.appendChild(script); });
  let detectedExe = params.get('exe');
  // Files should already be prepared after the first download, but keep a safety call
  // (idempotent) in case the user used an older cache or the picker path.
  try {
    await prepareGameFiles();
    const gDir = await gameDir(false);
    for await (const [name] of gDir.entries()) {
      if (name.toLowerCase() === 'igi.exe') { detectedExe = 'igi.exe'; break; }
    }
  } catch (e) {
    console.warn('Exe sync/patch error:', e);
  }
  const rebootGame = () => {
    if (run.exited) return;
    run.exited = true;
    window.rcExited = true;
    loading = false;
    try { hideLoading(); hideBoot(); } catch {}
    try { navigator.keyboard?.unlock?.(); } catch {}
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
    try { if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch?.(() => {}); } catch {}
    const u = new URL(location.href);
    u.searchParams.set('autoplay', '1');
    if (u.href === location.href) {
      location.reload();
    } else {
      location.replace(u.href);
    }
  };
  window.rcGameExited = (code) => {
    rebootGame();
  };

  const M = await createRecomp({
    locateFile: (p, prefix) => {
      if (p.endsWith('.wasm')) return (prefix || 'build/') + p + '?v=10';
      return (prefix || '') + p;
    },
    arguments: ['/opfs/' + OPFS_DIR],
    print: (t) => {
      console.log(t);
      if (typeof t === 'string' && (t.includes('exiting normally') || t.includes('game quit'))) {
        rebootGame();
      }
    },
    printErr: (t) => {
      // Host informational logs (e.g. [wgpu], [ddraw], [com] stubs) come through stderr;
      // treat real errors as error, everything else as log/warn so the console stays clean.
      const s = typeof t === 'string' ? t : String(t);
      if (s.startsWith('[') || s.includes('not implemented') || s.includes('BC texture') || s.includes('renderer ready') || s.includes('loaded /opfs') || s.includes('starting game') || s.includes('device:')) {
        console.log(t);
      } else {
        console.error(t);
      }
      if (typeof t === 'string' && (t.includes('exiting normally') || t.includes('game quit'))) {
        rebootGame();
      }
    },
    preRun: [(m) => {
      if (params.has('mute')) m.ENV.RC_NO_AUDIO = '1';
      if (detectedExe) m.ENV.RC_EXE = detectedExe;
      if (params.get('exe')) m.ENV.RC_EXE = params.get('exe');
      if (params.has('log')) m.ENV.RC_LOG = '1';
      if (params.has('pads')) m.ENV.RC_PADS = params.get('pads');
      if (params.has('input')) m.ENV.RC_INPUT = params.get('input');   // testing: scripted input (host/input.c)
      if (params.has('queue')) m.ENV.RC_QUEUE = params.get('queue');
      if (COHORT.on.wide) m.ENV.RC_WIDE_DISPLAY = '1';
      if (params.has('gpuskip')) m.ENV.RC_GPU_SKIP = '1';   // diagnostics: the executor issues no draws
      if (session) Object.assign(m.ENV, RcNetplay.gameEnv(session), { RC_USERDATA: '/opfs/' + netSaves(session) });
      m.ENV.RC_LOG_FPS = params.has('fps') ? '1' : '';
      if (!params.has('fps')) delete m.ENV.RC_LOG_FPS;
      // WebKit (Safari, and every browser on an iPhone or iPad) keeps a wasm memory resident in full from the
      // moment it is allocated and kills the page past ~2 GB, so there the guest memory is packed and grows
      // only as the game allocates (runtime.c, RC_MEM_COMPACT). ?mem=compact / ?mem=full force it either way.
      if (compactMemory()) m.ENV.RC_MEM_COMPACT = '1';
      // and there the frame's vertex/uniform uploads go up in one writeBuffer per batch instead of two per
      // draw (render_wgpu.c): WebKit's WebGPU holds a page-sized IPC copy per call for a while, which added
      // 1-2 GB to the page. ?gpu=coalesce / ?gpu=direct force it either way.
      const gpu = params.get('gpu');
      if (gpu === 'coalesce' || (gpu !== 'direct' && isWebKit())) m.ENV.RC_GPU_COALESCE = '1';
    }],
  });
  const canvas = $('canvas');
  M._rc_gpu_init(canvas.width, canvas.height);
  new ResizeObserver(() => { sizeCanvas(); M._rc_set_canvas_size(canvas.width, canvas.height); }).observe(canvas);
  hookInput(M, !!session);
  if (touch) { RcTouch.attach(M, $('stage'), canvas); followVisualViewport($('stage')); }
  subtitles(M, touch);
  if (session) { session.client.attach(M); showNetStatus(M, session); }
  startAudio(M, audio).catch((e) => console.warn('audio unavailable:', e));
  const poll = session ? pollLocalPad : pollGamepads;
  // Online, present at most 60 times a second: every Present is a lockstep frame, and the input delay and
  // the time a frame has to simulate are counted in those (netplay.js: autoDelay), so following a 120 Hz
  // display would halve both. Solo play follows the display. A frame is due every 1/60 s, with a little
  // tolerance so a 60 Hz display's own jitter doesn't skip one.
  let due = 0, booted = false, shownFrames = 0, lastPresent = 0, loading = false;
  // After the initial boot cover lifts, suppress the "LOADING MISSION" overlay for a short grace
  // period. On first launch the engine often shows a few menu frames and then immediately blocks
  // to load the first mission — without this grace the player would see two loading screens in a row.
  let bootGraceUntil = 0;
  const frame = (t) => {
    if (run.exited) return;
    poll(M);
    if (!session || t >= due - 4) {
      const n = M._rc_gpu_pump(1);
      if (n) {
        due = Math.max(due + 1000 / 60, t - 4);
        lastPresent = t;
        // Drop the boot cover only once the game is actually STREAMING frames (its menu/mission is up), not
        // on the first frame: while the game loads a cold install it submits nothing for up to ~2 minutes,
        // then a stray clear-frame, then the real render loop. Counting to a couple dozen frames waits for
        // that render loop so the cover never lifts onto a still-black screen.
        if (!booted) {
          shownFrames += n;
          if (shownFrames >= 24) {
            booted = true;
            hideBoot();
            bootGraceUntil = t + 12000; // 12s grace: no second loading overlay right after boot
          }
        } else if (loading) {
          loading = false;
          hideLoading(); // frames resumed: level finished loading
        }
      } else if (booted && !loading && !session && !run.exited && lastPresent &&
                 t - lastPresent > 2500 && t > bootGraceUntil) {
        // Booted and running, but no frame for 2.5 s: the game is blocked loading a mission/level.
        // Cover the frozen black screen so it doesn't look crashed (solo only — online must never stall).
        // Skipped during the post-boot grace period to avoid back-to-back loading screens on first start.
        loading = true;
        showLoading();
      }
    } else M._rc_gpu_pump(0);   // mid-frame readbacks only
    if (!run.exited) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // readbacks mid-frame are answered without waiting for vsync; online, the pad is also sampled here
  const pumpInterval = setInterval(() => {
    if (run.exited) { clearInterval(pumpInterval); return; }
    if (session) poll(M);
    M._rc_gpu_pump(0);
  }, 1);
  // Online, a hidden tab still has to present frames (browsers pause requestAnimationFrame there), or the
  // lockstep would freeze every other player with it.
  if (session) {
    const netInterval = setInterval(() => {
      if (run.exited) { clearInterval(netInterval); return; }
      if (document.hidden) { poll(M); M._rc_gpu_pump(1); }
    }, 16);
  }
  canvas.focus();
  window.recomp = M;
}

// Follow gate (index.html #iggate): the first Play shows a prompt to follow the site's Instagram; Play is
// enabled once the Follow link has been tapped (or "already following"), and the choice is remembered in
// this browser. A follow can't be checked from a website, so this is a prompt, not a lock. Test runs
// (?autoplay) skip it.
const FOLLOW_STORE = 'igi-ig-follow';
function followGate(next) {
  next();
}

async function boot() {
  show('loading');
  status('Checking game files…');
  const lFill = $('loading-bar-fill');
  const lPct = $('loading-percent');
  if (lFill) lFill.style.width = '0%';
  if (lPct) lPct.textContent = '0%';
  // Friendly, device-specific message when the browser can't run the game (WebGPU + cross-origin isolation
  // arrived on iPhone/iPad in iOS 26). Avoids developer jargon the tester would read as an error.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const needHint = isIOS
    ? 'On iPhone or iPad this needs iOS 26 or later, opened in Safari. Please update iOS and try again.'
    : 'Please use an up-to-date Chrome or Edge (Android or desktop), or Safari 26+ on Apple devices.';
  if (!crossOriginIsolated) { status('This browser can’t run the game yet — it’s missing a feature the game needs (cross-origin isolation). ' + needHint); return; }
  if (!navigator.gpu) { status('This browser doesn’t support WebGPU, which the game needs for graphics. ' + needHint); return; }
  // navigator.gpu can exist with no usable adapter (GPU or driver blocklisted, hardware acceleration off,
  // Remote Desktop / VM): say so instead of starting a game that can only show a black screen
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) ||
    await navigator.gpu.requestAdapter().catch(() => null) ||
    await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null);
  if (!adapter) {
    const firefox = /Firefox\//.test(navigator.userAgent);
    status('WebGPU is switched on in this browser but it found no usable graphics adapter. ' +
      (firefox ? 'Firefox only enables WebGPU for some GPUs and drivers (see about:support, "WebGPU"); Chrome or Edge usually work. '
        : 'Check that hardware acceleration is on in the browser settings and the graphics driver is up to date. ') +
      'Remote Desktop and virtual machines often have no GPU for the browser.');
    return;
  }
  if (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter)
    console.warn('WebGPU: only a software (fallback) adapter is available; the game will be slow');
  if (!navigator.storage?.getDirectory) { status('This browser has no Origin Private File System.'); return; }
  let readyStarted = false;
  const ready = () => {
    if (readyStarted) return;
    readyStarted = true;
    if (params.has('autoplay')) {
      run().catch(fail);
      return;
    }
    show('home');
  };
  migratePreset(!!(await readMarker()));   // the keyboard layout for players from before the layouts existed
  $('play').onclick = () => followGate(() => run().catch(fail));
  for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);
  $('folder').onchange = async (e) => {
    $('pick').classList.add('hidden');
    try { await importFromPicker(e.target.files); ready(); }
    catch (err) { status(err.message); $('pick').classList.remove('hidden'); }
  };
  const showPicker = (msg) => {
    status(msg);
    $('pick').classList.remove('hidden');
    $('help').classList.remove('hidden');
  };

  // A hosted game folder (game/manifest.json) is downloaded; without one the player picks their own copy.
  // Phones and tablets can't pick folders, so there it's the only way in.
  const hosted = await hostedManifest();
  const resetEl = $('reset');
  if (resetEl && hosted) resetEl.textContent = 'Reload the game again';
  const offerDownload = (msg) => {
    status(msg);
    $('download').textContent = 'Download the game (one time)';
    $('download').classList.remove('hidden');
  };
  $('download').onclick = async () => {
    $('download').classList.add('hidden');
    $('pick').classList.add('hidden');
    try { await importFromServer(hosted); ready(); }
    catch (err) { offerDownload(err.message); }
  };
  if (resetEl) {
    resetEl.onclick = (e) => {
      e.preventDefault();
      show('loading');
      if (hosted) offerDownload('Reload the game again.'); else showPicker('Choose your Project I.G.I. folder.');
    };
  }
  const marker = await readMarker();
  if (hosted) {
    const expectedVersion = await manifestVersion(hosted);
    if (!marker || marker.version !== expectedVersion) {
      status('Preparing the game files…');
      try {
        await importFromServer(hosted);
      } catch (err) {
        status(`Game loading failed: ${err.message} Refresh the page to resume.`);
        const sub = $('loading-subtext');
        if (sub) sub.textContent = 'The launcher will appear only after every game file has been downloaded and prepared.';
        return;
      }
    } else {
      status('Verifying the installed game…');
      const dir = await gameDir(false);
      let hasExe = false;
      for await (const [name] of dir.entries()) {
        if (name.toLowerCase() === 'igi.exe') { hasExe = true; break; }
      }
      if (!hasExe) {
        status('The installed game is incomplete. Preparing a fresh download…');
        try { await importFromServer(hosted); }
        catch (err) {
          status(`Game loading failed: ${err.message} Refresh the page to resume.`);
          return;
        }
      } else {
        await prepareGameFiles();
      }
    }
    ready();
    return;
  }
  if (!marker) {
    showPicker('Choose your Project I.G.I. folder to start.');
    return;
  }
  try {
    const dir = await gameDir(false);
    let hasExe = false;
    for await (const [name] of dir.entries()) {
      if (name.toLowerCase() === 'igi.exe') { hasExe = true; break; }
    }
    if (!hasExe) {
      showPicker('The installed game folder is incomplete. Choose the game folder again.');
      return;
    }
    status('Finishing game setup…');
    await prepareGameFiles();
  } catch (err) {
    status(`Game verification failed: ${err.message}`);
    return;
  }
  ready();
}

// ------------------------------------------------------------------ fullscreen

// The stage (game + overlays) goes fullscreen; the canvas grows with it and the game letterboxes its 4:3
// picture inside. Alt+Enter (Option+Enter on a Mac) toggles it, as in PC games of the time; it is caught
// before the game's own key handling so Enter doesn't also reach a menu.
function setupFullscreen() {
  const stage = $('stage');
  const active = () => document.fullscreenElement || document.webkitFullscreenElement;
  // body.fs drives the touch re-fullscreen pill (index.html): shown only when playing and NOT fullscreen.
  // Registered unconditionally (even where the desktop button is unavailable) so the pill is always right.
  const syncFsClass = () => document.body.classList.toggle('fs', !!active());
  document.addEventListener('fullscreenchange', syncFsClass);
  document.addEventListener('webkitfullscreenchange', syncFsClass);
  syncFsClass();
  const toggle = () => {
    if (active()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage)?.catch?.(() => {});
    $('canvas').focus();
  };
  if (!stage.requestFullscreen && !stage.webkitRequestFullscreen) { $('fs').classList.add('hidden'); return; }
  $('fs').onclick = toggle;
  const swallow = (e) => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (!e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && !e.repeat) toggle();
  };
  window.addEventListener('keydown', swallow, true);
  window.addEventListener('keyup', swallow, true);
  const sync = () => {
    $('fs-icon').setAttribute('d', active() ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
    $('fs').title = active() ? 'Exit fullscreen (Alt+Enter or Esc)' : 'Fullscreen (Alt+Enter)';
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  // the button shows while the mouse moves over the stage and fades after a few still seconds
  let idle;
  const wake = () => { stage.classList.add('awake'); clearTimeout(idle); idle = setTimeout(() => stage.classList.remove('awake'), 2500); };
  stage.addEventListener('mousemove', wake);
  stage.addEventListener('mouseleave', () => stage.classList.remove('awake'));
  wake();
}

// once the game starts: a short hint, so players learn the shortcut
function fullscreenTip() {
  const tip = $('fstip');
  if (!tip) return;
  if (document.fullscreenElement || document.webkitFullscreenElement || $('fs')?.classList.contains('hidden')) return;
  tip.classList.remove('hidden');
  tip.style.opacity = '1';
  setTimeout(() => { tip.style.opacity = '0'; }, 5000);
  setTimeout(() => tip.classList.add('hidden'), 5500);
}

// and, a moment later, the controls that differ from what players of other shooters expect
function controlsTip() {
  const tip = $('ctltip');
  if (!tip) return;
  const C = RcControls.get(), right = RcControls.ACTIONS[C.mouse[2]]?.label || 'nothing';
  const k = (id) => `<kbd>${keyLabel(userKeys[id])}</kbd>`;
  tip.innerHTML = preset === 'original'
    ? `Original keys: arrows move · ${k('walkrun')} walk/run · ${k('crouch')} crouch · ${k('jump')} jump · ${k('zoomin')}/${k('zoomout')} zoom · right click: <b>${right}</b> — WASD and more in the Controls panel`
    : `Right click: <b>${right}</b> · scroll: weapon · ${k('walkrun')} walk/run · ${k('crouch')} crouch · ${k('jump')} jump — change them in the Controls panel`;
  setTimeout(() => { tip.classList.remove('hidden'); tip.style.opacity = '1'; }, 6000);
  setTimeout(() => { tip.style.opacity = '0'; }, 16000);
  setTimeout(() => tip.classList.add('hidden'), 16500);
}

// ------------------------------------------------------------------ online lobby

// Keyboard cheat sheet beside the stage: in-game prompts use controller glyphs (triangle/circle/×/square,
// L1, R1), so keyboard players need a reference. The CSS (index.html) reserves the panel's space on
// viewports wide enough and shrinks the stage to match; the body's .kbd-off class (set when the player
// dismisses the panel, remembered in localStorage) hides the panel and lets the stage reclaim the space.
function setupKbdHelp() {
  const off = () => { try { return localStorage.getItem('rc-kbd') !== 'show'; } catch { return true; } };
  const save = (v) => { try { localStorage.setItem('rc-kbd', v); } catch { /* storage blocked */ } };
  const apply = () => document.body.classList.toggle('kbd-off', off());
  if ($('kbd-close')) $('kbd-close').onclick = () => { save('hide'); apply(); };
  if ($('kbd-show')) $('kbd-show').onclick = () => { save('show'); apply(); };
  const btnControls = $('btn-controls');
  if (btnControls) btnControls.onclick = () => {
    const isOff = document.body.classList.contains('kbd-off');
    save(isOff ? 'show' : 'hide');
    apply();
  };
  apply();
}

// The device choice on the landing screen (index.html #device): touch controls + gyroscope, or keyboard and
// mouse. Preselected from the browser (a coarse pointer on a touch screen), remembered in this browser, and
// applied right away: the page's phone layout (body.coarse) and the hints follow it, and run() asks
// RcTouch.wanted() when the game starts.
function setupDevice() {
  const sync = () => {
    const touch = RcTouch.wanted();
    document.body.classList.toggle('coarse', touch);
    document.body.classList.toggle('nofs', touch && !document.fullscreenEnabled && !document.webkitFullscreenEnabled);
    if (touch) {
      RcTouch.setup($('stage'), $('canvas'));
      $('home-controls')?.addEventListener('click', () => RcTouch.openSettings());
      $('boot-controls')?.addEventListener('click', () => RcTouch.openSettings());
    }
    const box = $('device');
    if (box) {
      for (const b of box.querySelectorAll('button')) {
        const on = (b.dataset.device === 'touch') === touch;
        b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
  };
  const box = $('device');
  if (box) {
    for (const b of box.querySelectorAll('button')) b.onclick = () => {
      try { localStorage.setItem('igi-device', b.dataset.device); } catch { /* storage blocked */ }
      sync();
    };
  }
  sync();
}
setupDevice();
setupFullscreen();
setupKbdHelp();
setupControls();
setupUIWiring();
boot();
