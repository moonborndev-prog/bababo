/* Canli Quiz - ortak yardimcilar (oyuncu + host) */
'use strict';

// Sik kimligi renk + sekil ile birlikte tasinir; renk tek basina birakilmaz.
const OPT_COLORS = ['#cd1526', '#2a71e5', '#b78b01', '#119a70', '#7d3ab7', '#d168a7'];
const OPT_INKS = ['#ffffff', '#ffffff', '#101223', '#101223', '#ffffff', '#101223'];

const OPT_SHAPES = [
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3 22 21H2Z"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 22 12 12 22 2 12Z"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle fill="currentColor" cx="12" cy="12" r="10"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="3" y="3" width="18" height="18" rx="2"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 21.5 9.2 17.9 21H6.1L2.5 9.2Z"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.8 14.9 8.1 21.8 8.9 16.7 13.6 18.1 20.4 12 17 5.9 20.4 7.3 13.6 2.2 8.9 9.1 8.1Z"/></svg>',
];

function shapeSpan(i, cls) {
  return '<span class="' + (cls || 'shape') + '">' + OPT_SHAPES[i % OPT_SHAPES.length] + '</span>';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtPts(n) {
  return new Intl.NumberFormat('tr-TR').format(n || 0);
}

function $(id) { return document.getElementById(id); }

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showView(views, id) {
  for (const v of views) {
    if (v === id) show($(v)); else hide($(v));
  }
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, bad) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  t.style.display = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

/* Geri sayim: sunucu saatine gore hizalanir */
function makeTimer(onTick, onDone) {
  let handle = null;
  let offset = 0;
  let endsAt = null;
  let totalMs = 0;
  let doneFired = false;

  function stop() {
    if (handle) { clearInterval(handle); handle = null; }
    endsAt = null;
  }

  function start(ends, serverNow, limitSec) {
    stop();
    doneFired = false;
    if (!ends) { onTick(null, null); return; }
    offset = serverNow - Date.now();
    endsAt = ends;
    totalMs = limitSec * 1000;
    const tick = () => {
      const remain = endsAt - (Date.now() + offset);
      if (remain <= 0) {
        onTick(0, 0);
        stop();
        if (!doneFired) { doneFired = true; if (onDone) onDone(); }
        return;
      }
      onTick(remain, totalMs);
    };
    tick();
    handle = setInterval(tick, 120);
  }

  return { start, stop };
}

function renderTimer(fillEl, numEl, remainMs, totalMs) {
  if (remainMs == null) {
    fillEl.parentElement.classList.add('hidden');
    numEl.classList.add('hidden');
    return;
  }
  fillEl.parentElement.classList.remove('hidden');
  numEl.classList.remove('hidden');
  const ratio = totalMs > 0 ? Math.max(0, remainMs / totalMs) : 0;
  fillEl.style.width = (ratio * 100).toFixed(1) + '%';
  const secs = Math.ceil(remainMs / 1000);
  numEl.textContent = secs;
  const low = remainMs <= 5200;
  fillEl.classList.toggle('low', low);
  numEl.classList.toggle('low', low);
}
