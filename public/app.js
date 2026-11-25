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
  selStamp: null,
  selRunner: null,
  editingRunnerId: null,
  rev: null,
  lbFilter: 'all',
  lbPage: 0,
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
const myStampIds = new Set();
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
const VIEWS = ['clock', 'finish', 'runners', 'leaderboard'];

function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'clock').split('?')[0];
  S.view = VIEWS.includes(name) ? name : 'clock';
  VIEWS.forEach((v) => ($('#view-' + v).hidden = v !== S.view));
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === S.view));
  document.body.dataset.view = S.view;
  if (S.view !== 'leaderboard') setScreenshotMode(false);
  lastSig = {};
  renderData();
  updateWakeLock();
  poll();
}
window.addEventListener('hashchange', route);

// ================================================================
// Wake lock (keep screens on for Clock and Finish)
// ================================================================
let wakeLock = null;
async function updateWakeLock() {
  const want = (S.view === 'clock' || S.view === 'finish') && document.visibilityState === 'visible';
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
// Finish view: offline-safe stamping
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

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>> 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

let lastFinishTap = 0;
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
  myStampIds.add(stamp.id);
  savePending([...loadPending(), stamp]);

  navigator.vibrate && navigator.vibrate(80);
  const btn = $('#finishBtn');
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');
  $('#lastStamp').innerHTML = `Stamped <b>${fmtTime(elapsed)}</b>`;

  toast(`⏱ ${fmtTime(elapsed)} recorded`, {
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
  $('#lastStamp').innerHTML = 'Last stamp undone';
  lastSig = {};
  renderData();
  syncPending();
}

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
      try {
        if (p.undone) {
          await api('/api/stamps/' + encodeURIComponent(p.id), { method: 'DELETE' });
          removePending(p.id);
        } else {
          await api('/api/stamps', { method: 'POST', body: { id: p.id, elapsed_ms: p.elapsed_ms, created_at: p.created_at } });
          const fresh = loadPending().find((x) => x.id === p.id);
          if (fresh && fresh.undone) continue; // undone mid-flight: next loop deletes it
          removePending(p.id);
        }
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
  el.className = 'sync-status ' + (n ? 'pending' : 'ok');
  el.textContent = n ? `⏳ ${n} finish time${n > 1 ? 's' : ''} waiting to sync…` : '✓ All finish times synced';
}

// Stamps as the user should see them: server list + local pending, minus undone.
function visibleStamps() {
  const pending = loadPending();
  const undone = new Set(pending.filter((p) => p.undone).map((p) => p.id));
  const serverIds = new Set(S.stamps.map((s) => s.id));
  const local = pending
    .filter((p) => !p.undone && !serverIds.has(p.id))
    .map((p) => ({ ...p, runner_id: null, pending: true }));
  return [...S.stamps.filter((s) => !undone.has(s.id)), ...local].sort((a, b) => b.created_at - a.created_at);
}

function runnerById(id) {
  return S.runners.find((r) => r.id === id);
}

function stampRowHtml(s, { assigned } = {}) {
  const r = assigned ? runnerById(s.runner_id) : null;
  const sel = S.selStamp === s.id ? ' sel' : '';
  return `<li class="row stamp-row${sel}${s.pending ? ' pending' : ''}" data-stamp="${escapeHtml(s.id)}">
    <span class="time">${fmtTime(s.elapsed_ms)}</span>
    ${r ? `<span class="who">${ageIcon(r.age_group)} <b>#${r.bib ?? '–'}</b> ${escapeHtml(fullName(r))}</span>` : ''}
    ${s.pending ? '<span class="tag">syncing</span>' : ''}
    <span class="row-actions">
      ${assigned ? '<button class="mini" data-act="unassign">Unassign</button>' : ''}
      ${!s.pending ? '<button class="mini" data-act="edit" title="Edit time">✎</button><button class="mini" data-act="delete" title="Delete">🗑</button>' : ''}
    </span>
  </li>`;
}

function renderFinish() {
  const stamps = visibleStamps();
  const unassigned = stamps.filter((s) => !s.runner_id);
  const assigned = stamps.filter((s) => s.runner_id);
  if (S.selStamp && !unassigned.some((s) => s.id === S.selStamp)) S.selStamp = null;

  $('#queueCount').textContent = unassigned.length || '';
  $('#stampQueue').innerHTML = unassigned.length
    ? unassigned.map((s) => stampRowHtml(s)).join('')
    : '<li class="empty">No unmatched times</li>';
  $('#assignedList').innerHTML = assigned.length
    ? assigned.map((s) => stampRowHtml(s, { assigned: true })).join('')
    : '<li class="empty">Nothing matched yet</li>';

  const q = $('#runnerSearch').value.trim().toLowerCase();
  const out = S.runners.filter((r) => r.finish_ms == null);
  if (S.selRunner && !out.some((r) => r.id === S.selRunner)) S.selRunner = null;
  const shown = out.filter((r) => !q || fullName(r).toLowerCase().includes(q) || String(r.bib) === q.replace('#', ''));
  $('#outCount').textContent = out.length || '';
  $('#outRunners').innerHTML = shown.length
    ? shown
        .map(
          (r) => `<li class="row runner-pick${S.selRunner === r.id ? ' sel' : ''}" data-runner="${r.id}">
            <b class="bib">#${r.bib ?? '–'}</b> ${ageIcon(r.age_group)} <span>${escapeHtml(fullName(r))}</span></li>`
        )
        .join('')
    : `<li class="empty">${out.length ? 'No match' : 'Everyone has a time'}</li>`;
}

$('#runnerSearch').addEventListener('input', () => renderFinish());

$('#stampQueue').addEventListener('click', (e) => handleStampClick(e));
$('#assignedList').addEventListener('click', (e) => handleStampClick(e));

async function handleStampClick(e) {
  const li = e.target.closest('[data-stamp]');
  if (!li) return;
  const id = li.dataset.stamp;
  const stamp = visibleStamps().find((s) => s.id === id);
  if (!stamp) return;
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (act === 'unassign') {
    if (!(await requireAuth('unassignStamp'))) return;
    return assignStamp(id, null);
  }
  if (act === 'edit') {
    if (!(await requireAuth('editTime'))) return;
    const v = await promptDialog('Edit time', 'Format H:MM:SS.t (for example 0:23:41.7)', { value: fmtTime(stamp.elapsed_ms) });
    if (v == null) return;
    const ms = parseTime(v);
    if (ms == null) return toast("Couldn't read that time.");
    try {
      await api('/api/stamps/' + encodeURIComponent(id), { method: 'PATCH', body: { elapsed_ms: ms } });
      toast('Time updated.');
    } catch (err) {
      toast('Failed: ' + escapeHtml(err.message));
    }
    return poll();
  }
  if (act === 'delete') {
    if (!(await requireAuth('deleteStamp'))) return;
    if (!(await confirmDialog('Delete this time?', `${fmtTime(stamp.elapsed_ms)} will be removed${stamp.runner_id ? ' and the runner will have no time' : ''}.`, 'Delete', true))) return;
    try {
      await api('/api/stamps/' + encodeURIComponent(id), { method: 'DELETE' });
      S.stamps = S.stamps.filter((s) => s.id !== id);
      toast('Deleted.');
    } catch (err) {
      toast('Failed: ' + escapeHtml(err.message));
    }
    return poll();
  }
  if (stamp.runner_id) return; // assigned rows only have buttons
  if (stamp.pending) return toast('That time is still syncing. One moment…');
  S.selStamp = S.selStamp === id ? null : id;
  maybeAssign();
}

$('#outRunners').addEventListener('click', (e) => {
  const li = e.target.closest('[data-runner]');
  if (!li) return;
  const id = Number(li.dataset.runner);
  S.selRunner = S.selRunner === id ? null : id;
  maybeAssign();
});

function maybeAssign() {
  if (S.selStamp && S.selRunner) {
    const s = S.selStamp;
    const r = S.selRunner;
    S.selStamp = S.selRunner = null;
    assignStamp(s, r);
  } else {
    renderFinish();
    if (S.selStamp) toast('Now tap the runner.', { ms: 1500 });
    else if (S.selRunner) toast('Now tap their time.', { ms: 1500 });
  }
}

async function assignStamp(stampId, runnerId) {
  if (runnerId != null && !(await requireAuth('assignStamp'))) return;
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
    if (r) toast(`✓ ${escapeHtml(fullName(r))}: ${fmtTime(stamp ? stamp.elapsed_ms : 0)}`);
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
    bib: f.bib.value === '' ? null : Number(f.bib.value),
  };
  const editing = S.editingRunnerId;
  if (!(await requireAuth(editing ? 'editRunner' : 'addRunner'))) return;
  try {
    if (editing) {
      if (body.bib == null) delete body.bib;
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

$('#runnerFilter').addEventListener('input', () => renderRunners());

function renderRunners() {
  const q = $('#runnerFilter').value.trim().toLowerCase();
  const list = S.runners.filter((r) => !q || fullName(r).toLowerCase().includes(q) || String(r.bib) === q.replace('#', ''));
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
    : `<li class="empty">${S.runners.length ? 'No match' : S.loadedFull ? 'No runners yet. Add some above.' : 'Loading…'}</li>`;
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
    f.bib.value = r.bib ?? '';
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
    if (!(await confirmDialog('Delete runner?', `Remove <b>${escapeHtml(fullName(r))}</b>? Their finish time (if any) goes back to the unmatched list.`, 'Delete', true))) return;
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
function leaderboardRows() {
  return S.runners
    .filter((r) => r.finish_ms != null && (S.lbFilter === 'all' || r.age_group === S.lbFilter))
    .sort((a, b) => a.finish_ms - b.finish_ms || (a.stamp_created_at || 0) - (b.stamp_created_at || 0) || a.id - b.id);
}

function renderLeaderboard() {
  const rows = leaderboardRows();
  const size = CONFIG.leaderboardPageSize;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  S.lbPage = Math.min(S.lbPage, pages - 1);
  const start = S.lbPage * size;
  const pageRows = rows.slice(start, start + size);
  $('#lbFilterLabel').textContent = S.lbFilter === 'all' ? 'Overall' : AGE_GROUPS[S.lbFilter].label + ' division';
  $('#lbRows').innerHTML = pageRows.length
    ? pageRows
        .map((r, i) => {
          const rank = start + i + 1;
          const medal = rank <= 3 ? ` medal-${rank}` : '';
          return `<li class="lb-row${medal}">
            <span class="lb-rank">${rank}</span>
            ${ageIcon(r.age_group, 'lb-icon')}
            <span class="lb-name">${escapeHtml(fullName(r))}</span>
            <span class="lb-time">${fmtTime(r.finish_ms)}</span>
          </li>`;
        })
        .join('')
    : `<li class="lb-empty">${S.loadedFull ? 'No finishers yet. Go go go! 🦃' : 'Loading…'}</li>`;
  $('#lbPageLabel').textContent = pages > 1 ? `Page ${S.lbPage + 1} of ${pages}` : '';
  $('#lbPrev').disabled = S.lbPage === 0;
  $('#lbNext').disabled = S.lbPage >= pages - 1;
  $('.lb-pager').hidden = pages <= 1;
}

$('#lbChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  S.lbFilter = b.dataset.filter;
  S.lbPage = 0;
  $$('#lbChips .chip').forEach((c) => c.classList.toggle('on', c === b));
  renderLeaderboard();
});
$('#lbPrev').addEventListener('click', () => { S.lbPage--; renderLeaderboard(); });
$('#lbNext').addEventListener('click', () => { S.lbPage++; renderLeaderboard(); });

function setScreenshotMode(on) {
  document.body.classList.toggle('shot', on);
}
$('#shotBtn').addEventListener('click', () => setScreenshotMode(true));
$('#shotExit').addEventListener('click', () => setScreenshotMode(false));

// ================================================================
// Rendering (only redraw lists when their data changed, so inputs aren't disturbed)
// ================================================================
let lastSig = {};
function renderData() {
  renderClockStatus();
  const pendingSig = localStorage.getItem(PENDING_KEY) || '';
  const dataSig = JSON.stringify([S.runners, S.stamps]);
  const sig = S.view + '|' + dataSig + '|' + pendingSig + '|' + S.selStamp + '|' + S.selRunner;
  if (lastSig[S.view] === sig) return;
  lastSig[S.view] = sig;
  if (S.view === 'finish') {
    renderFinish();
    renderSyncStatus();
  } else if (S.view === 'runners') renderRunners();
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
