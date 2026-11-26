/* Turkey Trot 5K race-day app. Vanilla JS, no build step. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ================================================================
// State
// ================================================================
const S = {
  race: { start_at_ms: null, end_at_ms: null, status: 'idle' },
  runners: [],
  stamps: [],
  loadedFull: false,
  online: true,
  view: 'clock',
  editingRunnerId: null,
  rev: null,
};

// ================================================================
// API
// ================================================================
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ================================================================
// Clock sync: elapsed = estimatedServerNow - start_at_ms
// ================================================================
const Sync = { samples: [], offset: null };

function clientNow() {
  return performance.timeOrigin + performance.now();
}
function serverNow() {
  return clientNow() + (Sync.offset ?? 0);
}
function addSyncSample(t0, t1, serverMs) {
  if (!Number.isFinite(serverMs)) return;
  const rtt = t1 - t0;
  const offset = serverMs - (performance.timeOrigin + (t0 + t1) / 2);
  Sync.samples.push({ rtt, offset });
  if (Sync.samples.length > 15) Sync.samples.shift();
  // The lowest round-trip sample is the most trustworthy.
  const best = Sync.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  Sync.offset = best.offset;
}

function raceElapsed() {
  const r = S.race;
  if (r.start_at_ms == null) return null;
  const end = r.end_at_ms != null ? r.end_at_ms : serverNow();
  return end - r.start_at_ms;
}
function isLive() {
  return S.race.start_at_ms != null && S.race.end_at_ms == null;
}

// ================================================================
// Polling
// ================================================================
let pollTimer = null;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  const t0 = performance.now();
  try {
    const d = await api('/api/state' + (S.rev != null ? '?rev=' + S.rev : ''));
    addSyncSample(t0, performance.now(), d.server_time_ms);
    S.race = d.race;
    if (d.runners) {
      if (S.loadedFull) announceFinishes(d.runners, d.stamps);
      S.runners = d.runners;
      S.stamps = d.stamps;
      S.loadedFull = true;
      S.rev = d.race.rev;
    }
    setOnline(true);
    renderData();
  } catch (e) {
    setOnline(false);
    if (e.status === 500) console.warn(e.message);
  } finally {
    polling = false;
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(poll, CONFIG.checkEveryMs);
}

function setOnline(ok) {
  S.online = ok;
  const dot = $('#netDot');
  dot.classList.toggle('off', !ok);
  dot.title = ok ? 'Connected' : 'Offline, retrying';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
  } else {
    Sync.samples = []; // re-sync after being in the background
    poll();
    syncPending();
    updateWakeLock();
  }
});
window.addEventListener('online', () => {
  poll();
  syncPending();
});

// ================================================================
// "Somebody finished!" pulse, shown on every open screen
// ================================================================
// Stamps made on this phone (kept across reloads so the list under the button survives).
const MINE_KEY = 'tt_mine_v1';
const myStampIds = new Set((() => {
  try { return JSON.parse(localStorage.getItem(MINE_KEY) || '[]'); } catch { return []; }
})());
function rememberMine(id) {
  myStampIds.add(id);
  localStorage.setItem(MINE_KEY, JSON.stringify([...myStampIds].slice(-300)));
}
const pulseQueue = [];
let pulseBusy = false;

function announceFinishes(newRunners, newStamps) {
  const oldStampIds = new Set(S.stamps.map((s) => s.id));
  const oldTimes = new Map(S.runners.map((r) => [r.id, r.finish_ms]));
  const named = new Set();
  newRunners.forEach((r) => {
    if (r.finish_ms != null && oldTimes.has(r.id) && oldTimes.get(r.id) == null) {
      named.add(r.stamp_id);
      pulse(`🏁 <b>${escapeHtml(fullName(r))}</b> finished! <span class="pulse-time">${fmtTime(r.finish_ms)}</span>`);
    }
  });
  newStamps.forEach((s) => {
    if (!oldStampIds.has(s.id) && !myStampIds.has(s.id) && !named.has(s.id)) {
      pulse(`🏁 Someone just finished! <span class="pulse-time">${fmtTime(s.elapsed_ms)}</span>`);
    }
  });
}

function pulse(html) {
  pulseQueue.push(html);
  if (!pulseBusy) nextPulse();
}
function nextPulse() {
  const html = pulseQueue.shift();
  const el = $('#pulse');
  if (!html) {
    pulseBusy = false;
    el.hidden = true;
    return;
  }
  pulseBusy = true;
  el.innerHTML = html;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  document.body.classList.remove('glow');
  void document.body.offsetWidth;
  document.body.classList.add('glow');
  setTimeout(nextPulse, 3500);
}

// ================================================================
// Router
// ================================================================
const VIEWS = ['clock', 'runners', 'leaderboard'];

function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'clock').split('?')[0];
  S.view = VIEWS.includes(name) ? name : 'clock';
  VIEWS.forEach((v) => ($('#view-' + v).hidden = v !== S.view));
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === S.view));
  document.body.dataset.view = S.view;
  lastSig = {};
  renderData();
  updateWakeLock();
  poll();
}
window.addEventListener('hashchange', route);

// ================================================================
// Wake lock (keep the home screen on)
// ================================================================
let wakeLock = null;
async function updateWakeLock() {
  const want = S.view === 'clock' && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
// Some browsers only grant the lock after a user gesture.
document.addEventListener('pointerdown', () => { if (!wakeLock) updateWakeLock(); }, { passive: true });

// ================================================================
// UI helpers: toast, modal, password gate
// ================================================================
function toast(html, { ms = 3000, action, onAction } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${html}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.addEventListener('click', () => {
      onAction && onAction();
      el.remove();
    });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

let modalResolve = null;
function openModal(html, { onOpen, dismissable = true } = {}) {
  closeModal(null);
  $('#modal .modal-box').classList.remove('modal-wide');
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal').dataset.dismissable = dismissable ? '1' : '';
  return new Promise((resolve) => {
    modalResolve = resolve;
    onOpen && onOpen($('#modalBody'));
  });
}
function closeModal(value) {
  if (!$('#modal').hidden) $('#modal').hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' && $('#modal').dataset.dismissable) closeModal(null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal(null);
});

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return openModal(
    `<h2>${title}</h2><p>${text}</p>
     <div class="modal-actions">
       <button class="btn btn-ghost" data-act="cancel">Cancel</button>
       <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${okLabel}</button>
     </div>`,
    {
      onOpen: (box) => {
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(false);
        box.querySelector('[data-act=ok]').onclick = () => closeModal(true);
      },
    }
  ).then((v) => v === true);
}

function promptDialog(title, text, { value = '', placeholder = '', okLabel = 'Save', inputmode = 'text' } = {}) {
  return openModal(
    `<h2>${title}</h2><p>${text}</p>
     <form data-act="form"><input class="input" name="v" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" inputmode="${inputmode}" autocomplete="off">
     <div class="modal-actions">
       <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
       <button type="submit" class="btn btn-primary">${okLabel}</button>
     </div></form>`,
    {
      onOpen: (box) => {
        const input = box.querySelector('input');
        setTimeout(() => input.focus(), 50);
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        box.querySelector('form').onsubmit = (e) => {
          e.preventDefault();
          closeModal(input.value);
        };
      },
    }
  );
}

// Frontend-only password gate (not real security, by design).
function isUnlocked() {
  return Number(sessionStorage.getItem('tt_unlocked_until') || 0) > Date.now();
}
async function requireAuth(action) {
  if (!CONFIG.protectedActions[action]) return true;
  if (isUnlocked()) return true;
  const pw = await openModal(
    `<h2>🔒 Password needed</h2><p>This is an important change. Enter the race password.</p>
     <form data-act="form"><input class="input" type="password" name="pw" placeholder="Password" autocomplete="off">
     <div class="pw-error" hidden>That's not it. Try again.</div>
     <div class="modal-actions">
       <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
       <button type="submit" class="btn btn-primary">Unlock</button>
     </div></form>`,
    {
      onOpen: (box) => {
        const input = box.querySelector('input');
        setTimeout(() => input.focus(), 50);
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        box.querySelector('form').onsubmit = (e) => {
          e.preventDefault();
          if (input.value === CONFIG.password) closeModal(true);
          else {
            box.querySelector('.pw-error').hidden = false;
            input.select();
          }
        };
      },
    }
  );
  if (pw === true) {
    sessionStorage.setItem('tt_unlocked_until', String(Date.now() + CONFIG.unlockMinutes * 60000));
    return true;
  }
  return false;
}

// ================================================================
// Clock view
// ================================================================
let lastClockText = '';
let lastCountdown = '';

function frame() {
  const el = raceElapsed();
  const shown = el == null || el < 0 ? 0 : el;
  const text = fmtTime(shown);
  if (text !== lastClockText) {
    lastClockText = text;
    $$('[data-clock]').forEach((n) => (n.textContent = text));
  }
  // Countdown overlay: 5-4-3-2-1 then GO for ~1.2s, from the shared start time.
  let cd = '';
  if (el != null && el < 0 && el > -CONFIG.countdownShowMs) cd = String(Math.ceil(-el / 1000));
  else if (el != null && el >= 0 && el < 1200 && S.race.end_at_ms == null) cd = 'GO!';
  if (cd !== lastCountdown) {
    lastCountdown = cd;
    $('#countdown').hidden = !cd;
    $('#countdownNum').textContent = cd;
    $('#countdown').classList.toggle('go', cd === 'GO!');
    if (cd) {
      // restart the pop animation
      const n = $('#countdownNum');
      n.style.animation = 'none';
      void n.offsetWidth;
      n.style.animation = '';
    }
    renderClockStatus();
  }
  requestAnimationFrame(frame);
}

function renderClockStatus() {
  const r = S.race;
  let text = 'Waiting for the start';
  let cls = 'idle';
  if (r.start_at_ms != null && r.end_at_ms != null) {
    text = 'Race over · final clock';
    cls = 'ended';
  } else if (r.start_at_ms != null) {
    const el = raceElapsed();
    text = el != null && el < 0 ? 'Get ready…' : 'Race in progress';
    cls = 'running';
  }
  const s = $('#clockStatus');
  s.textContent = text;
  s.className = 'clock-status ' + cls;
  $('#bigClock').className = 'big-clock ' + cls;
}

// --- Hidden start: double-tap, then within 1.5s press & hold 3s ---
(function setupEasterEgg() {
  const el = $('#bigClock');
  const fill = $('#holdFill');
  const TAP_MAX_MS = 300;
  const DOUBLE_GAP_MS = 400;
  const ARM_WINDOW_MS = 1500;
  const HOLD_MS = 3000;
  let downAt = 0;
  let lastTapAt = 0;
  let armedUntil = 0;
  let holding = false;
  let holdTimer = null;
  let holdStart = 0;
  let raf = null;

  const canStart = () => S.race.start_at_ms == null;

  function drawHold() {
    if (!holding) return;
    const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    fill.style.width = p * 100 + '%';
    raf = requestAnimationFrame(drawHold);
  }
  function startHold() {
    holding = true;
    holdStart = performance.now();
    fill.parentElement.classList.add('active');
    drawHold();
    holdTimer = setTimeout(() => {
      resetHold();
      armedUntil = 0;
      if (canStart()) openStartModal();
    }, HOLD_MS);
  }
  function resetHold() {
    holding = false;
    clearTimeout(holdTimer);
    cancelAnimationFrame(raf);
    fill.style.width = '0%';
    fill.parentElement.classList.remove('active');
  }

  el.addEventListener('pointerdown', (e) => {
    if (!canStart()) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const now = performance.now();
    downAt = now;
    if (now < armedUntil) startHold();
  });
  el.addEventListener('pointerup', () => {
    const now = performance.now();
    if (holding) {
      resetHold(); // released early: cancel
      armedUntil = 0;
      return;
    }
    if (now - downAt <= TAP_MAX_MS) {
      if (now - lastTapAt <= DOUBLE_GAP_MS) {
        armedUntil = now + ARM_WINDOW_MS;
        lastTapAt = 0;
      } else {
        lastTapAt = now;
      }
    }
  });
  el.addEventListener('pointercancel', () => {
    resetHold();
    armedUntil = 0;
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('dblclick', (e) => e.preventDefault());
})();

function openStartModal() {
  openModal(
    `<h2 class="center">Are you super duper sure you want to start the race?</h2>
     <div class="slider" id="startSlider">
       <div class="slider-fill"></div>
       <div class="slider-label">Yes</div>
       <div class="slider-knob" aria-label="Slide to start">➜</div>
     </div>
     <div class="modal-actions center"><button class="btn btn-ghost" data-act="cancel">Cancel</button></div>`,
    {
      onOpen: (box) => {
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        setupSlider(box.querySelector('#startSlider'), () => {
          closeModal(true);
          startRace();
        });
      },
    }
  );
}

function setupSlider(track, onDone) {
  const knob = track.querySelector('.slider-knob');
  const fillEl = track.querySelector('.slider-fill');
  let dragging = false;
  let startX = 0;
  let x = 0;
  let done = false;
  const max = () => track.clientWidth - knob.offsetWidth - 8;
  const set = (v, animate) => {
    x = Math.max(0, Math.min(max(), v));
    knob.style.transition = fillEl.style.transition = animate ? 'transform .25s, width .25s' : 'none';
    knob.style.transform = `translateX(${x}px)`;
    fillEl.style.width = x + knob.offsetWidth / 2 + 4 + 'px';
  };
  knob.addEventListener('pointerdown', (e) => {
    if (done) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX - x;
    try { knob.setPointerCapture(e.pointerId); } catch {}
  });
  knob.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    set(e.clientX - startX, false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (x >= max() * 0.95) {
      done = true;
      set(max(), true);
      navigator.vibrate && navigator.vibrate(40);
      setTimeout(onDone, 150);
    } else {
      set(0, true);
    }
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  set(0, false);
}

async function startRace() {
  if (!(await requireAuth('startRace'))) return;
  try {
    const d = await api('/api/start', { method: 'POST' });
    S.race = d.race;
    if (!d.started) toast('The race was already started.');
    renderData();
  } catch (e) {
    toast('Could not start: ' + escapeHtml(e.message));
  }
  poll();
}

// Race controls menu (End / Resume / Reset)
$('#raceMenuBtn').addEventListener('click', async () => {
  const r = S.race;
  const started = r.start_at_ms != null;
  const ended = r.end_at_ms != null;
  const choice = await openModal(
    `<h2>Race controls</h2>
     <div class="menu">
       ${started && !ended ? '<button class="btn btn-primary" data-v="end">🏁 End race (freeze clock)</button>' : ''}
       ${ended ? '<button class="btn btn-primary" data-v="resume">▶️ Resume race clock</button>' : ''}
       <button class="btn btn-danger-ghost" data-v="reset">↺ Reset race (clear times, keep runners)</button>
       <button class="btn btn-ghost" data-v="">Close</button>
     </div>`,
    {
      onOpen: (box) => box.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => closeModal(b.dataset.v || null))),
    }
  );
  if (choice === 'end') {
    if (!(await requireAuth('endRace'))) return;
    if (!(await confirmDialog('End the race?', 'The clock will freeze. Results are kept, and late finishers can still be stamped.', 'End race'))) return;
    await raceAction('/api/end', {});
  } else if (choice === 'resume') {
    if (!(await requireAuth('endRace'))) return;
    await raceAction('/api/end', { resume: true });
  } else if (choice === 'reset') {
    if (!(await requireAuth('resetRace'))) return;
    if (!(await confirmDialog('Reset the race?', 'This clears the start time and <b>every finish time</b>. Runners stay. This cannot be undone.', 'Reset race', true))) return;
    await raceAction('/api/reset', { scope: 'race' });
  }
});

async function raceAction(path, body) {
  try {
    const d = await api(path, { method: 'POST', body });
    S.race = d.race;
    toast('Done.');
  } catch (e) {
    toast('Failed: ' + escapeHtml(e.message));
  }
  poll();
}

// ================================================================
// Home: "Someone Finished" button, offline-safe stamping
// ================================================================
const PENDING_KEY = 'tt_pending_v1';
function loadPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}
function savePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  renderSyncStatus();
}
function removePending(id) {
  savePending(loadPending().filter((p) => p.id !== id));
}
function updatePending(id, patch) {
  const list = loadPending();
  const p = list.find((x) => x.id === id);
  if (!p) return false;
  Object.assign(p, patch);
  savePending(list);
  return true;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>> 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

let lastFinishTap = 0;
let undoToast = null;
function onFinishTap() {
  const tapServerNow = serverNow(); // capture the instant first
  const now = performance.now();
  if (now - lastFinishTap < CONFIG.finishLockoutMs) return;
  lastFinishTap = now;
  const r = S.race;
  if (r.start_at_ms == null) {
    toast("The race hasn't started yet.");
    return;
  }
  const elapsed = Math.round(tapServerNow - r.start_at_ms);
  if (elapsed < 0) {
    toast('Still counting down!');
    return;
  }
  const stamp = { id: uuid(), elapsed_ms: elapsed, created_at: Math.round(tapServerNow) };
  rememberMine(stamp.id);
  savePending([...loadPending(), stamp]);

  navigator.vibrate && navigator.vibrate(80);
  const btn = $('#finishBtn');
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');

  // One undo toast at a time, always for the latest tap.
  if (undoToast) undoToast.remove();
  undoToast = toast(`⏱ ${fmtTime(elapsed)} recorded`, {
    ms: CONFIG.undoSeconds * 1000,
    action: 'Undo',
    onAction: () => undoStamp(stamp.id),
  });
  lastSig = {};
  renderData();
  syncPending();
}

$('#finishBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onFinishTap();
});
$('#finishBtn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onFinishTap();
  }
});
$('#finishBtn').addEventListener('contextmenu', (e) => e.preventDefault());

// Undo (allowed without password only inside the toast window).
function undoStamp(id) {
  const list = loadPending();
  const p = list.find((x) => x.id === id);
  if (p) p.undone = true;
  else list.push({ id, undone: true });
  savePending(list);
  S.stamps = S.stamps.filter((s) => s.id !== id);
  S.runners.forEach((r) => {
    if (r.stamp_id === id) { r.stamp_id = null; r.finish_ms = null; }
  });
  toast('Time removed.');
  lastSig = {};
  renderData();
  syncPending();
}

// Pending entries may also carry edits made before they reached the server
// (an adjusted elapsed_ms and/or a runner_id). After the idempotent POST we
// replay those as PATCHes, then drop the entry only if nothing changed meanwhile.
let syncing = false;
let syncRetry = null;
async function syncPending() {
  if (syncing) return;
  syncing = true;
  clearTimeout(syncRetry);
  renderSyncStatus();
  try {
    while (true) {
      const list = loadPending();
      if (!list.length) break;
      const p = list[0];
      const snap = JSON.stringify(p);
      const url = '/api/stamps/' + encodeURIComponent(p.id);
      try {
        if (p.undone) {
          await api(url, { method: 'DELETE' });
          removePending(p.id);
          continue;
        }
        await api('/api/stamps', { method: 'POST', body: { id: p.id, elapsed_ms: p.elapsed_ms, created_at: p.created_at } });
        // POST is INSERT OR IGNORE, so an earlier attempt may have stored an older time.
        if (p.adjusted) await api(url, { method: 'PATCH', body: { elapsed_ms: p.elapsed_ms } });
        if ('runner_id' in p) await api(url, { method: 'PATCH', body: { runner_id: p.runner_id } });
        const fresh = loadPending().find((x) => x.id === p.id);
        if (fresh && JSON.stringify(fresh) !== snap) continue; // edited mid-flight: replay
        removePending(p.id);
      } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          removePending(p.id); // permanently bad, drop it
          continue;
        }
        break; // offline or server trouble: retry later
      }
    }
  } finally {
    syncing = false;
    renderSyncStatus();
    if (loadPending().length) syncRetry = setTimeout(syncPending, 2000);
    else poll();
  }
}

function renderSyncStatus() {
  const n = loadPending().filter((p) => !p.undone).length;
  const el = $('#syncStatus');
  if (!el) return;
  el.hidden = !n;
  el.textContent = n ? `⏳ ${n} time${n > 1 ? 's' : ''} saved on this phone, waiting to sync…` : '';
}

// Stamps as the user should see them: server list + local pending, minus undone.
function visibleStamps() {
  const pending = loadPending();
  const undone = new Set(pending.filter((p) => p.undone).map((p) => p.id));
  const serverIds = new Set(S.stamps.map((s) => s.id));
  const local = pending
    .filter((p) => !p.undone && !serverIds.has(p.id))
    .map((p) => ({ ...p, runner_id: p.runner_id ?? null, pending: true }));
  return [...S.stamps.filter((s) => !undone.has(s.id)), ...local].sort((a, b) => b.created_at - a.created_at);
}

function runnerById(id) {
  return S.runners.find((r) => r.id === id);
}

function homeStampHtml(s) {
  const r = s.runner_id != null ? runnerById(s.runner_id) : null;
  const who = r
    ? `<span class="ms-who">${ageIcon(r.age_group, 'ms-icon')}<span>${escapeHtml(fullName(r))}</span></span>`
    : '<span class="ms-ask">Who was this?</span>';
  return `<li><button type="button" class="ms-item${r ? ' named' : ''}${s.pending ? ' pending' : ''}" data-stamp="${escapeHtml(s.id)}">
    <span class="ms-time">${fmtTime(s.elapsed_ms)}</span>${who}
    ${s.pending ? '<span class="ms-sync" title="Saved on this phone, syncing">⏳</span>' : ''}
    <span class="ms-chev">›</span></button></li>`;
}

function renderHome() {
  const stamps = visibleStamps();
  // Once a time has a name it leaves the home screen (fix mistakes from See / Add Runners).
  const mine = stamps.filter((s) => myStampIds.has(s.id) && s.runner_id == null);
  $('#myStamps').innerHTML = mine.map(homeStampHtml).join('');
  // Unnamed times from other phones, tucked away so nothing gets orphaned.
  const others = stamps.filter((s) => !myStampIds.has(s.id) && s.runner_id == null);
  $('#otherStampsWrap').hidden = !others.length;
  $('#otherStampsLabel').textContent = `${others.length} unnamed time${others.length > 1 ? 's' : ''} from other phones`;
  $('#otherStamps').innerHTML = others.map(homeStampHtml).join('');
  renderSyncStatus();
}

$('#view-clock').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stamp]');
  if (b) openStampSheet(b.dataset.stamp);
});

function findStamp(id) {
  return visibleStamps().find((s) => s.id === id);
}

async function openStampSheet(id) {
  const s = findStamp(id);
  if (!s) return;
  const r = s.runner_id != null ? runnerById(s.runner_id) : null;
  const choice = await openModal(
    `<div class="sheet-time">${fmtTime(s.elapsed_ms)}</div>
     <div class="sheet-sub">${r ? `${ageIcon(r.age_group, 'ms-icon')} ${escapeHtml(fullName(r))}` : 'Not named yet'}</div>
     <div class="sheet-actions">
       <button class="btn btn-ghost sheet-btn" data-v="adjust">⏱ Adjust Time</button>
       <button class="btn btn-primary sheet-btn" data-v="who">👤 Who was this?</button>
     </div>
     <div class="sheet-foot">
       <button class="link-quiet" data-v="delete">Remove this time</button>
       <button class="link-quiet" data-v="">Close</button>
     </div>`,
    { onOpen: (box) => box.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => closeModal(b.dataset.v || null))) }
  );
  if (choice === 'adjust') adjustTime(id);
  else if (choice === 'who') pickRunner(id);
  else if (choice === 'delete') deleteStamp(id);
}

// ---------- Adjust Time ----------
async function adjustTime(id) {
  const s = findStamp(id);
  if (!s) return;
  // This phone's own taps can be nudged freely; other phones' times need the password.
  if (!myStampIds.has(id) && !(await requireAuth('editTime'))) return;
  let ms = s.elapsed_ms;
  const steps = [-5000, -1000, -100, 100, 1000, 5000];
  const label = (d) => (d > 0 ? '+' : '−') + (Math.abs(d) >= 1000 ? Math.abs(d) / 1000 + 's' : '0.1s');
  const v = await openModal(
    `<h2>Adjust time</h2>
     <form data-act="form" class="adjust">
       <input class="input adjust-input" name="v" value="${fmtTime(ms)}" inputmode="decimal" autocomplete="off" aria-label="Finish time">
       <div class="nudges">${steps.map((d) => `<button type="button" class="nudge" data-d="${d}">${label(d)}</button>`).join('')}</div>
       <div class="hint center">Type it (like 0:23:41.7) or nudge it.</div>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
         <button type="submit" class="btn btn-primary">Save</button>
       </div>
     </form>`,
    {
      onOpen: (box) => {
        const input = box.querySelector('input');
        box.querySelectorAll('.nudge').forEach(
          (b) =>
            (b.onclick = () => {
              const cur = parseTime(input.value);
              ms = Math.max(0, (cur == null ? ms : cur) + Number(b.dataset.d));
              input.value = fmtTime(ms);
            })
        );
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        box.querySelector('form').onsubmit = (e) => {
          e.preventDefault();
          closeModal(input.value);
        };
      },
    }
  );
  if (v == null) return;
  const next = parseTime(v);
  if (next == null) return toast("Couldn't read that time.");
  if (next === s.elapsed_ms) return;
  if (updatePending(id, { elapsed_ms: next, adjusted: true })) {
    toast(`Time changed to ${fmtTime(next)}.`);
    lastSig = {};
    renderData();
    return syncPending();
  }
  try {
    await api('/api/stamps/' + encodeURIComponent(id), { method: 'PATCH', body: { elapsed_ms: next } });
    const st = S.stamps.find((x) => x.id === id);
    if (st) st.elapsed_ms = next;
    S.runners.forEach((r) => { if (r.stamp_id === id) r.finish_ms = next; });
    toast(`Time changed to ${fmtTime(next)}.`);
  } catch (err) {
    toast('Failed: ' + escapeHtml(err.message));
  }
  lastSig = {};
  renderData();
  poll();
}

// ---------- Who was this? ----------
function lastInitial(r) {
  return String(r.last_name || '').trim().charAt(0).toUpperCase();
}
function byLastInitial(a, b) {
  const la = lastInitial(a);
  const lb = lastInitial(b);
  if (!la !== !lb) return la ? -1 : 1; // no last initial goes at the end
  return la.localeCompare(lb) || String(a.first_name).localeCompare(String(b.first_name), undefined, { sensitivity: 'base' }) || a.id - b.id;
}

async function pickRunner(id) {
  const s = findStamp(id);
  if (!s) return;
  const current = s.runner_id;
  // Runners who already have a time (on the server or waiting to sync) are left out.
  const taken = new Set(S.runners.filter((r) => r.finish_ms != null).map((r) => r.id));
  visibleStamps().forEach((x) => { if (x.runner_id != null) taken.add(x.runner_id); });
  const list = S.runners.filter((r) => r.id === current || !taken.has(r.id)).sort(byLastInitial);
  const pill = (r) => `<button type="button" class="pill${r.id === current ? ' on' : ''}" data-runner="${r.id}">
      ${ageIcon(r.age_group, 'pill-icon')}<span class="pill-name">${escapeHtml(r.first_name)}${lastInitial(r) ? ` <b>${lastInitial(r)}.</b>` : ''}</span></button>`;
  const picked = await openModal(
    `<h2>Who finished at <span class="mono">${fmtTime(s.elapsed_ms)}</span>?</h2>
     ${list.length > 16 ? '<input class="input pill-search" type="search" placeholder="Search" autocomplete="off">' : ''}
     ${list.length ? '' : '<div class="hint pill-none">Everyone on the list already has a time. Add this runner here:</div>'}
     <div class="pill-grid">${list.map(pill).join('')}<button type="button" class="pill pill-new" data-act="new"><span class="pill-plus">＋</span><span class="pill-name">New runner</span></button></div>
     <div class="sheet-foot">
       ${current != null ? '<button class="link-quiet" data-act="clear">Not them, clear name</button>' : '<span></span>'}
       <button class="link-quiet" data-act="cancel">Cancel</button>
     </div>`,
    {
      onOpen: (box) => {
        box.closest('.modal-box').classList.add('modal-wide');
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        const clr = box.querySelector('[data-act=clear]');
        if (clr) clr.onclick = () => closeModal('clear');
        box.querySelectorAll('.pill[data-runner]').forEach((b) => (b.onclick = () => closeModal(Number(b.dataset.runner))));
        box.querySelector('[data-act=new]').onclick = () => closeModal('new');
        const q = box.querySelector('.pill-search');
        if (q)
          q.oninput = () => {
            const t = q.value.trim().toLowerCase();
            box.querySelectorAll('.pill[data-runner]').forEach((b) => {
              b.hidden = t && !b.textContent.toLowerCase().replace(/\s+/g, ' ').includes(t);
            });
          };
      },
    }
  );
  if (picked == null) return;
  if (picked === 'new') return addRunnerForStamp(id);
  const runnerId = picked === 'clear' ? null : picked;
  if (runnerId === current) return;
  assignStamp(id, runnerId);
}

// Add a runner who isn't on the list yet, then give them this time.
async function addRunnerForStamp(id) {
  const s = findStamp(id);
  if (!s) return;
  const body = await openModal(
    `<h2>New runner at <span class="mono">${fmtTime(s.elapsed_ms)}</span></h2>
     <form data-act="form" class="form" autocomplete="off">
       <div class="form-row">
         <input name="first_name" class="input" placeholder="First name" required>
         <input name="last_name" class="input input-initial" placeholder="Last initial" maxlength="1" autocapitalize="characters">
       </div>
       <div class="toggle new-age">
         <button type="button" data-value="youngster" class="on">Youngster</button>
         <button type="button" data-value="unc">Unc</button>
       </div>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
         <button type="submit" class="btn btn-primary">Add &amp; give them this time</button>
       </div>
     </form>`,
    {
      onOpen: (box) => {
        const f = box.querySelector('form');
        setTimeout(() => f.first_name.focus(), 50);
        box.querySelectorAll('.new-age button').forEach(
          (b) => (b.onclick = () => box.querySelectorAll('.new-age button').forEach((x) => x.classList.toggle('on', x === b)))
        );
        box.querySelector('[data-act=cancel]').onclick = () => closeModal(null);
        f.onsubmit = (e) => {
          e.preventDefault();
          if (!f.first_name.value.trim()) return;
          closeModal({
            first_name: f.first_name.value,
            last_name: f.last_name.value,
            age_group: box.querySelector('.new-age button.on').dataset.value,
          });
        };
      },
    }
  );
  if (!body) return;
  if (!(await requireAuth('addRunner'))) return;
  try {
    const before = new Set(S.runners.map((r) => r.id));
    const d = await api('/api/runners', { method: 'POST', body });
    const added = (d.runners || []).filter((r) => !before.has(r.id)).sort((a, b) => b.id - a.id)[0];
    if (!added) throw new Error('Runner was not created');
    S.runners = d.runners;
    await assignStamp(id, added.id);
  } catch (err) {
    toast("Couldn't add runner: " + escapeHtml(err.message));
    poll();
  }
}

async function deleteStamp(id) {
  const s = findStamp(id);
  if (!s) return;
  if (!(await requireAuth('deleteStamp'))) return;
  if (!(await confirmDialog('Remove this time?', `${fmtTime(s.elapsed_ms)} will be removed${s.runner_id != null ? ' and that runner will have no time' : ''}.`, 'Remove', true))) return;
  undoStamp(id);
}

async function assignStamp(stampId, runnerId) {
  if (runnerId != null && !(await requireAuth('assignStamp'))) return;
  // Not on the server yet: remember the name with the pending time; sync sends it.
  if (updatePending(stampId, { runner_id: runnerId })) {
    const r = runnerById(runnerId);
    toast(r ? `✓ ${escapeHtml(fullName(r))}` : 'Name cleared.');
    lastSig = {};
    renderData();
    return syncPending();
  }
  // Optimistic update
  const stamp = S.stamps.find((s) => s.id === stampId);
  if (stamp) {
    S.runners.forEach((r) => {
      if (r.stamp_id === stampId) { r.stamp_id = null; r.finish_ms = null; }
    });
    stamp.runner_id = runnerId;
    const r = runnerById(runnerId);
    if (r) { r.stamp_id = stampId; r.finish_ms = stamp.elapsed_ms; }
  }
  lastSig = {};
  renderData();
  try {
    await api('/api/stamps/' + encodeURIComponent(stampId), { method: 'PATCH', body: { runner_id: runnerId } });
    const r = runnerById(runnerId);
    toast(r ? `✓ ${escapeHtml(fullName(r))}: ${fmtTime(stamp ? stamp.elapsed_ms : 0)}` : 'Name cleared.');
  } catch (e) {
    toast('Failed: ' + escapeHtml(e.message));
  }
  poll();
}

// ================================================================
// Runners view
// ================================================================
function toggleValue(name) {
  return $(`[data-toggle="${name}"] button.on`).dataset.value;
}
function setToggle(name, value) {
  $$(`[data-toggle="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.value === value));
}
$$('[data-toggle] button').forEach((b) =>
  b.addEventListener('click', () => setToggle(b.parentElement.dataset.toggle, b.dataset.value))
);

function resetRunnerForm() {
  S.editingRunnerId = null;
  const f = $('#runnerForm');
  f.reset();
  setToggle('age', 'youngster');
  $('#runnerFormTitle').textContent = 'Add a runner';
  $('#runnerSaveBtn').textContent = 'Add runner';
  $('#runnerCancelBtn').hidden = true;
}
$('#runnerCancelBtn').addEventListener('click', resetRunnerForm);

$('#runnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    first_name: f.first_name.value,
    last_name: f.last_name.value,
    age_group: toggleValue('age'),
  };
  const editing = S.editingRunnerId;
  if (!(await requireAuth(editing ? 'editRunner' : 'addRunner'))) return;
  try {
    if (editing) {
      await api('/api/runners/' + editing, { method: 'PATCH', body });
      toast('Saved.');
    } else {
      await api('/api/runners', { method: 'POST', body });
      toast(`Added ${escapeHtml(body.first_name)}.`);
    }
    resetRunnerForm();
    f.first_name.focus();
  } catch (err) {
    toast('Failed: ' + escapeHtml(err.message));
  }
  poll();
});

$('#bulkAddBtn').addEventListener('click', async () => {
  const def = toggleValue('bulkAge');
  const lines = $('#bulkText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('Paste at least one name.');
  const runners = lines.map((line) => {
    let [name, group] = line.split(/[,\t]/).map((x) => (x || '').trim());
    let age = def;
    const g = (group || '').toLowerCase();
    if (g.startsWith('u')) age = 'unc';
    else if (g.startsWith('y') || g.startsWith('k')) age = 'youngster';
    else {
      // allow "Jane Doe unc" without a comma
      const m = name.match(/\s+(unc|youngster)$/i);
      if (m) {
        age = m[1].toLowerCase();
        name = name.slice(0, m.index);
      }
    }
    const parts = name.split(/\s+/);
    return { first_name: parts.shift(), last_name: parts.join(' '), age_group: age };
  });
  if (!(await requireAuth('addRunner'))) return;
  try {
    await api('/api/runners', { method: 'POST', body: { runners } });
    $('#bulkText').value = '';
    toast(`Added ${runners.length} runner${runners.length > 1 ? 's' : ''}.`);
  } catch (err) {
    toast('Failed: ' + escapeHtml(err.message));
  }
  poll();
});

// Hidden shortcuts: press & hold. Fires fn(el) after `ms`; the click that
// follows the release is swallowed so the normal tap action doesn't run.
function onLongPress(root, selector, fn, ms = 700) {
  let timer = null, startX = 0, startY = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(selector);
    if (!el || !root.contains(el)) return;
    fired = false;
    startX = e.clientX; startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      if (navigator.vibrate) navigator.vibrate(30);
      fn(el);
    }, ms);
  });
  root.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => root.addEventListener(t, cancel));
  root.addEventListener('click', (e) => {
    if (fired && e.target.closest(selector)) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; }
  }, true);
  root.addEventListener('contextmenu', (e) => { if (e.target.closest(selector)) e.preventDefault(); });
}

// Hold "Add runner" → show/hide bulk add
onLongPress($('#runnerForm'), '#runnerSaveBtn', () => {
  if (S.editingRunnerId) return;
  const p = $('#bulkPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) {
    p.open = true;
    p.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#bulkText').focus({ preventScroll: true });
  }
});
// Hold any "Edit" → print bibs
onLongPress($('#runnerList'), '[data-act="edit"]', () => { location.href = '/bibs.html'; });

function renderRunners() {
  const list = S.runners;
  const done = S.runners.filter((r) => r.finish_ms != null).length;
  $('#runnerSummary').textContent = S.runners.length ? `${S.runners.length} runners · ${done} finished` : '';
  $('#runnerList').innerHTML = list.length
    ? list
        .map(
          (r) => `<li class="row runner-row" data-id="${r.id}">
        <b class="bib">#${r.bib ?? '–'}</b>
        ${ageIcon(r.age_group)}
        <span class="name">${escapeHtml(fullName(r))}<small>${AGE_GROUPS[r.age_group].label}</small></span>
        <span class="time">${r.finish_ms != null ? fmtTime(r.finish_ms) : '—'}</span>
        <span class="row-actions">
          <button class="mini" data-act="edit">Edit</button>
          ${r.finish_ms != null ? '<button class="mini" data-act="clear">Clear time</button>' : ''}
          <button class="mini" data-act="delete" title="Delete">🗑</button>
        </span>
      </li>`
        )
        .join('')
    : `<li class="empty">${S.loadedFull ? 'No runners yet. Add some above.' : 'Loading…'}</li>`;
}

$('#runnerList').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-id]');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!li || !act) return;
  const r = runnerById(Number(li.dataset.id));
  if (!r) return;
  if (act === 'edit') {
    S.editingRunnerId = r.id;
    const f = $('#runnerForm');
    f.first_name.value = r.first_name;
    f.last_name.value = r.last_name;
    setToggle('age', r.age_group);
    $('#runnerFormTitle').textContent = `Edit #${r.bib ?? ''} ${fullName(r)}`;
    $('#runnerSaveBtn').textContent = 'Save changes';
    $('#runnerCancelBtn').hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (act === 'clear') {
    if (!(await requireAuth('unassignStamp'))) return;
    if (r.stamp_id) assignStamp(r.stamp_id, null);
  } else if (act === 'delete') {
    if (!(await requireAuth('deleteRunner'))) return;
    if (!(await confirmDialog('Delete runner?', `Remove <b>${escapeHtml(fullName(r))}</b>? Their finish time (if any) goes back to being unnamed.`, 'Delete', true))) return;
    try {
      await api('/api/runners/' + r.id, { method: 'DELETE' });
      toast('Deleted.');
    } catch (err) {
      toast('Failed: ' + escapeHtml(err.message));
    }
    poll();
  }
});

$('#clearAllBtn').addEventListener('click', async () => {
  if (!(await requireAuth('clearAll'))) return;
  const v = await promptDialog('Clear ALL data?', 'This deletes every runner, every finish time, and resets the race. Type <b>CLEAR</b> to confirm.', { okLabel: 'Clear everything' });
  if ((v || '').trim().toUpperCase() !== 'CLEAR') return;
  await raceAction('/api/reset', { scope: 'all' });
});

// ================================================================
// Leaderboard
// ================================================================
const FIVE_K_MILES = 3.10686;

function leaderboardRows() {
  return S.runners
    .filter((r) => r.finish_ms != null)
    .sort((a, b) => a.finish_ms - b.finish_ms || (a.stamp_created_at || 0) - (b.stamp_created_at || 0) || a.id - b.id);
}

// Average pace per mile over a 5K, e.g. 1122000 ms -> "6:01/mi"
function fmtPace(ms) {
  const sec = Math.round(ms / 1000 / FIVE_K_MILES);
  return `${Math.floor(sec / 60)}:${pad2(sec % 60)}/mi`;
}

// Gold/silver/bronze laurel half; the right side is the same branch mirrored.
function laurel(side) {
  const leaves = [[19, 52, -58], [13, 42, -38], [10, 31, -18], [10, 20, 4], [13, 10, 26]]
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="3.2" ry="7" transform="rotate(${r} ${x} ${y})"/>`)
    .join('');
  const inner = [[22, 42, 40], [18, 31, 25], [17, 20, 12]]
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="2.4" ry="5.5" transform="rotate(${r} ${x} ${y})"/>`)
    .join('');
  const flip = side === 'r' ? ' transform="translate(30 0) scale(-1 1)"' : '';
  return `<svg class="laurel laurel-${side}" viewBox="0 0 30 64" aria-hidden="true"><g fill="currentColor"${flip}>` +
    `<path d="M24 60 Q8 40 14 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>${leaves}${inner}</g></svg>`;
}

const MAPLE = 'M50 2 L56 20 L66 14 L63 34 L80 22 L78 32 L96 30 L86 44 L94 48 L70 64 L74 72 L54 70 L52 98 L48 98 L46 70 L26 72 L30 64 L6 48 L14 44 L4 30 L22 32 L20 22 L37 34 L34 14 L44 20 Z';
const LEAVES_SVG = `<svg viewBox="0 0 220 220" aria-hidden="true"><defs>
  <path id="maple" d="${MAPLE}"/>
  <linearGradient id="lgA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E8731F"/><stop offset="1" stop-color="#B8401A"/></linearGradient>
  <linearGradient id="lgB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7B733"/><stop offset="1" stop-color="#E07B1A"/></linearGradient>
  <linearGradient id="lgC" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8C9A0"/><stop offset="1" stop-color="#EE9A5C"/></linearGradient></defs>
  <use href="#maple" fill="url(#lgA)" transform="translate(-14 -18) rotate(-28 50 50) scale(1.15)"/>
  <use href="#maple" fill="url(#lgB)" transform="translate(78 -26) rotate(22 50 50) scale(.8)"/>
  <use href="#maple" fill="url(#lgC)" opacity=".9" transform="translate(92 56) rotate(48 50 50) scale(.62)"/>
  <use href="#maple" fill="url(#lgC)" opacity=".85" transform="translate(-6 96) rotate(-52 50 50) scale(.66)"/>
</svg>`;
$$('[data-leaves]').forEach((el) => (el.innerHTML = LEAVES_SVG));

function renderLeaderboard() {
  const rows = leaderboardRows();
  // Times show as H:MM:SS like the race board; tenths appear only where two shown times would look tied.
  const short = rows.map((r) => fmtTime(r.finish_ms, false));
  $('#lbRows').innerHTML = rows.length
    ? rows
        .map((r, i) => {
          const rank = i + 1;
          const tied = short[i] === short[i - 1] || short[i] === short[i + 1];
          const place = rank <= 3 ? `${laurel('l')}<b>${rank}</b>${laurel('r')}` : `<b>${rank}</b>`;
          return `<li class="lb-row${rank <= 3 ? ` medal medal-${rank}` : ''}">
            <span class="lb-place">${place}</span>
            <span class="lb-who"><span class="lb-name">${escapeHtml(fullName(r))}</span>${ageIcon(r.age_group, 'lb-icon')}</span>
            <span class="lb-time">${tied ? fmtTime(r.finish_ms) : short[i]}</span>
            <span class="lb-pace">${fmtPace(r.finish_ms)}</span>
          </li>`;
        })
        .join('')
    : `<li class="lb-empty">${S.loadedFull ? 'No finishers yet. Go go go! 🦃' : 'Loading…'}</li>`;
}

// ================================================================
// Rendering (only redraw lists when their data changed, so inputs aren't disturbed)
// ================================================================
let lastSig = {};
function renderData() {
  renderClockStatus();
  const pendingSig = localStorage.getItem(PENDING_KEY) || '';
  const dataSig = JSON.stringify([S.runners, S.stamps]);
  const sig = S.view + '|' + dataSig + '|' + pendingSig;
  if (lastSig[S.view] === sig) return;
  lastSig[S.view] = sig;
  if (S.view === 'clock') renderHome();
  else if (S.view === 'runners') renderRunners();
  else if (S.view === 'leaderboard') renderLeaderboard();
}

// ================================================================
// Boot
// ================================================================
paintArt();
probeAgeIcons().then(() => { lastSig = {}; renderData(); });
route();
syncPending();
requestAnimationFrame(frame);
