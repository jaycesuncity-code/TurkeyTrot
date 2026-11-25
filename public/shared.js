/* Shared bits for every page: config, formatting, icons. */
'use strict';

// ===== Settings you may want to tweak =====
const CONFIG = {
  password: 'password',
  unlockMinutes: 10,
  // true = needs the password ("important changes"); false = anyone can do it.
  protectedActions: {
    startRace: false,
    markFinish: false,
    assignStamp: false,
    unassignStamp: false,
    addRunner: false,
    editRunner: false,
    endRace: true,
    resetRace: true,
    deleteRunner: true,
    deleteStamp: true,
    editTime: true,
    clearAll: true,
  },
  undoSeconds: 10,
  finishLockoutMs: 350,
  // How often each open page asks "has anything changed?". The reply is tiny unless
  // something did change. The clock itself runs on each device and never needs this.
  checkEveryMs: 4000,
  countdownShowMs: 5000, // visible 5-4-3-2-1 (the server starts the race 10s out)
  leaderboardPageSize: 10,
  year: new Date().getFullYear(),
};

// ===== Age groups and icon slot =====
// Drop /assets/icons/youngster.png and /assets/icons/unc.png in to replace the emoji badges.
const AGE_GROUPS = {
  youngster: { label: 'Youngster', emoji: '🐥', file: '/assets/icons/youngster.png' },
  unc: { label: 'Unc', emoji: '🧓', file: '/assets/icons/unc.png' },
};
const iconAvailable = { youngster: false, unc: false };

async function probeAgeIcons() {
  await Promise.all(
    Object.entries(AGE_GROUPS).map(async ([key, g]) => {
      try {
        const res = await fetch(g.file, { cache: 'no-cache' });
        const type = res.headers.get('content-type') || '';
        iconAvailable[key] = res.ok && type.startsWith('image/');
      } catch {
        iconAvailable[key] = false;
      }
    })
  );
}

// <AgeIcon>: returns HTML for an age-group icon, falling back to an emoji badge.
function ageIcon(group, extraClass = '') {
  const g = AGE_GROUPS[group] || AGE_GROUPS.youngster;
  if (iconAvailable[group]) {
    return `<img class="age-icon ${extraClass}" src="${g.file}" alt="${g.label}" title="${g.label}">`;
  }
  return `<span class="age-badge age-${group} ${extraClass}" title="${g.label}" aria-label="${g.label}">${g.emoji}</span>`;
}

// ===== Formatting =====
function pad2(n) {
  return String(n).padStart(2, '0');
}

// 1421700 -> "0:23:41.7"
function fmtTime(ms, tenths = true) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) ms = 0;
  const totalTenths = Math.floor(ms / 100);
  const t = totalTenths % 10;
  const s = Math.floor(totalTenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = s % 60;
  return `${h}:${pad2(m)}:${pad2(sec)}` + (tenths ? `.${t}` : '');
}

// Accepts "23:41", "23:41.7", "0:23:41.7", "1:02:03.45" -> ms (or null)
function parseTime(text) {
  const m = String(text || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 && m[1] !== undefined) return null;
  if (sec > 59) return null;
  const frac = m[4] ? Number((m[4] + '00').slice(0, 3)) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000 + frac;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fullName(r) {
  const li = String(r.last_name || '').trim().charAt(0).toUpperCase();
  return `${r.first_name || ''}${li ? ` ${li}.` : ''}`.trim();
}

// ===== Inline art =====
const TURKEY_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(32 38)">
<ellipse rx="7" ry="20" fill="#C8642A" transform="rotate(-62) translate(0 -14)"/>
<ellipse rx="7" ry="20" fill="#E0A526" transform="rotate(-31) translate(0 -14)"/>
<ellipse rx="7" ry="20" fill="#6B1A2C" transform="translate(0 -14)"/>
<ellipse rx="7" ry="20" fill="#E0A526" transform="rotate(31) translate(0 -14)"/>
<ellipse rx="7" ry="20" fill="#C8642A" transform="rotate(62) translate(0 -14)"/>
<circle r="12" fill="#7a4a2a"/><circle cy="-12" r="6.5" fill="#8f5d38"/>
<path d="M-1 -12.5 L5 -11 L-1 -9 Z" fill="#E0A526"/><path d="M-2 -9 q-3 4 0 7 q2 -3 0 -7z" fill="#B3262E"/>
<circle cx="-1.5" cy="-14" r="1.3" fill="#1b1b1b"/>
<path d="M-5 11 v6 M5 11 v6" stroke="#E0A526" stroke-width="2" stroke-linecap="round"/></g></svg>`;

const LEAF_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 L37 20 L52 14 L46 28 L60 32 L46 37 L52 50 L37 44 L32 60 L27 44 L12 50 L18 37 L4 32 L18 28 L12 14 L27 20 Z" fill="#C8642A"/><path d="M32 18 V62" stroke="#6B1A2C" stroke-width="2.5" stroke-linecap="round"/></svg>`;

function paintArt(root = document) {
  root.querySelectorAll('[data-turkey]').forEach((el) => (el.innerHTML = TURKEY_SVG));
  root.querySelectorAll('[data-leaf]').forEach((el) => (el.innerHTML = LEAF_SVG));
  root.querySelectorAll('[data-year]').forEach((el) => (el.textContent = CONFIG.year));
}
