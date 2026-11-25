'use strict';
let runners = [];


function oneBib(b) {
  const numStr = String(b.bib ?? '');
  const sizeClass = numStr.length >= 5 ? 'n5' : numStr.length === 4 ? 'n4' : '';
  const name = b.blank ? '<div class="bib-name blank"></div>' : `<div class="bib-name">${escapeHtml(fullName(b))}</div>`;
  const group = b.blank
    ? '<span class="bib-group">Youngster ☐ &nbsp; Unc ☐</span>'
    : `<span class="bib-group">${ageIcon(b.age_group)} ${AGE_GROUPS[b.age_group].label}</span>`;
  return `<div class="bib">
    <span class="pin tl"></span><span class="pin tr"></span><span class="pin bl"></span><span class="pin br"></span>
    <div class="bib-band"><span class="turkey">${TURKEY_SVG}</span>Turkey Trot 5K · ${CONFIG.year}<span class="turkey">${TURKEY_SVG}</span></div>
    <div class="bib-num ${sizeClass}">${escapeHtml(numStr)}</div>
    ${name}
    <div class="bib-foot">${group}<span><span class="leaf">${LEAF_SVG}</span> Sun City Plumbing &amp; Heating</span></div>
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
  let next = runners.reduce((m, r) => Math.max(m, r.bib || 0), 0) + 1;
  for (let i = 0; i < blanks; i++) list.push({ blank: true, bib: next++ });

  const sheets = [];
  for (let i = 0; i < list.length; i += 2) {
    sheets.push(`<div class="sheet">${oneBib(list[i])}${list[i + 1] ? oneBib(list[i + 1]) : ''}</div>`);
  }
  document.getElementById('sheets').innerHTML = sheets.join('');
  document.getElementById('summary').textContent = list.length
    ? `${list.length} bib${list.length > 1 ? 's' : ''} on ${sheets.length} sheet${sheets.length > 1 ? 's' : ''}.` +
      (blanks ? ` Blank bibs use the next numbers; enter that number as the Bib # when you add a walk-up runner.` : '')
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
