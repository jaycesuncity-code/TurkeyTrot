'use strict';
let runners = [];
const blankNums = [];


function oneBib(b) {
  const numStr = String(b.bib ?? '');
  const sizeClass = 'n' + Math.min(Math.max(numStr.length, 1), 5);
  const name = b.blank
    ? '<div class="bib-name blank"></div>'
    : `<div class="bib-name">${escapeHtml(fullName(b).toUpperCase())}</div>`;
  const team = b.blank
    ? '<div class="bib-team blank"><span class="team-word">TEAM</span><span class="team-pick">UNCS ☐ &nbsp; YOUNGSTERS ☐</span></div>'
    : `<div class="bib-team team-${b.age_group}"><span class="team-word">TEAM</span><span class="team-name">${b.age_group === 'unc' ? 'UNCS' : 'YOUNGSTERS'}</span></div>`;
  return `<div class="bib">
    <img class="bib-bg" src="/assets/bib-template.png" alt="">
    <div class="bib-num ${sizeClass}">${escapeHtml(numStr)}</div>
    ${name}
    ${team}
  </div>`;
}

function render() {
  const sort = document.getElementById('sort').value;
  const blanks = Math.max(0, Math.min(60, Number(document.getElementById('blanks').value) || 0));
  const list = [...runners].sort((a, b) =>
    sort === 'last'
      ? (a.last_name || '').localeCompare(b.last_name || '') || (a.first_name || '').localeCompare(b.first_name || '')
      : (a.bib ?? 1e9) - (b.bib ?? 1e9)
  );
  // Blank bibs get random unused 5-digit numbers, kept stable while you adjust the count.
  const used = new Set(runners.map((r) => r.bib));
  while (blankNums.length < blanks) {
    const n = 10000 + Math.floor(Math.random() * 90000);
    if (!used.has(n) && !blankNums.includes(n)) blankNums.push(n);
  }
  for (let i = 0; i < blanks; i++) list.push({ blank: true, bib: blankNums[i] });

  const sheets = [];
  for (let i = 0; i < list.length; i += 2) {
    sheets.push(`<div class="sheet">${oneBib(list[i])}${list[i + 1] ? oneBib(list[i + 1]) : ''}</div>`);
  }
  document.getElementById('sheets').innerHTML = sheets.join('');
  document.getElementById('summary').textContent = list.length
    ? `${list.length} bib${list.length > 1 ? 's' : ''} on ${sheets.length} sheet${sheets.length > 1 ? 's' : ''}.` +
      (blanks ? ` Each blank bib has its own number; enter it as the Bib # when you add a walk-up runner.` : '')
    : 'No runners yet. Add runners first, or add blank bibs.';
}

document.getElementById('sort').addEventListener('change', render);
document.getElementById('blanks').addEventListener('input', render);
document.getElementById('printBtn').addEventListener('click', () => window.print());

(async function boot() {
  await probeAgeIcons();
  try {
    const res = await fetch('/api/runners', { cache: 'no-store' });
    const d = await res.json();
    runners = d.runners || [];
  } catch {
    document.getElementById('summary').textContent = 'Could not load runners. Check your connection and reload.';
  }
  render();
})();
