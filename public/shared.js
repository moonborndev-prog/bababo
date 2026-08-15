/* BaBaBo Quiz - ortak yardimcilar (oyuncu + host) */
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

/* ---------------- skor tablosu: once/sonra animasyonu ----------------
 * rows: [{rank, prevRank, nickname, score, prevScore, gain}]
 * opts: { animate: bool, isMe: fn(nickname)->bool, youRow: row|null }
 * Once onceki sirali hali gosterir, +puan rozetleri duser, skorlar sayarak
 * artar ve satirlar FLIP animasyonuyla yeni sirasina kayar.
 */

function lbRowEl(r, isMe) {
  const el = document.createElement('div');
  el.className = 'lb-row' + (isMe ? ' me' : '');
  el.dataset.name = r.nickname;
  el.innerHTML =
    '<div class="rank num"></div>' +
    '<div class="name">' + esc(r.nickname) + '</div>' +
    '<span class="badge-slot"></span>' +
    '<div class="pts num"></div>';
  return el;
}

function setRowRank(el, rank) {
  el.classList.remove('r1', 'r2', 'r3');
  if (rank <= 3) el.classList.add('r' + rank);
  el.querySelector('.rank').textContent = rank;
}

function countUp(el, from, to, dur, token) {
  const t0 = performance.now();
  function frame(t) {
    if (token.cancelled) return;
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtPts(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderLeaderboardAnimated(listEl, rows, opts) {
  opts = opts || {};
  if (listEl._lbToken) listEl._lbToken.cancelled = true;
  const token = { cancelled: false };
  listEl._lbToken = token;

  const all = rows.slice();
  let youAppended = null;
  if (opts.youRow && !all.some((r) => r.nickname === opts.youRow.nickname)) {
    youAppended = opts.youRow;
  }

  listEl.innerHTML = '';
  const items = []; // { row, el }
  const isMe = opts.isMe || (() => false);

  const startOrder = opts.animate
    ? all.slice().sort((a, b) => (a.prevRank || 999) - (b.prevRank || 999) || (b.prevScore || 0) - (a.prevScore || 0))
    : all.slice().sort((a, b) => a.rank - b.rank);

  startOrder.forEach((r, i) => {
    const el = lbRowEl(r, isMe(r.nickname));
    el.style.animationDelay = (i * 55) + 'ms';
    if (opts.animate) {
      setRowRank(el, r.prevRank || r.rank);
      el.querySelector('.pts').textContent = fmtPts(r.prevScore != null ? r.prevScore : r.score);
    } else {
      setRowRank(el, r.rank);
      el.querySelector('.pts').textContent = fmtPts(r.score);
      if (r.gain > 0) el.querySelector('.badge-slot').innerHTML = '<span class="gain-badge num">+' + fmtPts(r.gain) + '</span>';
    }
    listEl.appendChild(el);
    items.push({ row: r, el });
  });

  if (youAppended) {
    const dots = document.createElement('div');
    dots.className = 'centered muted tiny';
    dots.textContent = '...';
    listEl.appendChild(dots);
    const el = lbRowEl(youAppended, true);
    if (opts.animate) {
      setRowRank(el, youAppended.prevRank || youAppended.rank);
      el.querySelector('.pts').textContent = fmtPts(youAppended.prevScore != null ? youAppended.prevScore : youAppended.score);
      items.push({ row: youAppended, el, fixed: true });
    } else {
      setRowRank(el, youAppended.rank);
      el.querySelector('.pts').textContent = fmtPts(youAppended.score);
      if (youAppended.gain > 0) el.querySelector('.badge-slot').innerHTML = '<span class="gain-badge num">+' + fmtPts(youAppended.gain) + '</span>';
    }
    listEl.appendChild(el);
  }

  if (!opts.animate) return;

  // 1) rozetler + sayac
  setTimeout(() => {
    if (token.cancelled) return;
    let stagger = 0;
    for (const it of items) {
      const g = it.row.gain || 0;
      if (g <= 0) continue;
      const slot = it.el.querySelector('.badge-slot');
      const pts = it.el.querySelector('.pts');
      setTimeout(() => {
        if (token.cancelled) return;
        slot.innerHTML = '<span class="gain-badge num">+' + fmtPts(g) + '</span>';
        countUp(pts, it.row.prevScore || 0, it.row.score, 750, token);
      }, stagger);
      stagger += 120;
    }

    // 2) FLIP: yeni siralamaya kay
    setTimeout(() => {
      if (token.cancelled) return;
      const flowItems = items.filter((it) => !it.fixed);
      const first = new Map();
      for (const it of flowItems) first.set(it.row.nickname, it.el.getBoundingClientRect().top);
      const sorted = flowItems.slice().sort((a, b) => a.row.rank - b.row.rank);
      const anchor = listEl.firstChild;
      for (const it of sorted) listEl.insertBefore(it.el, null);
      // sabit (senin satirin) ve "..." en sonda kalsin
      const dots = listEl.querySelector('.tiny');
      if (dots) listEl.appendChild(dots);
      const fixedIt = items.find((it) => it.fixed);
      if (fixedIt) listEl.appendChild(fixedIt.el);

      for (const it of flowItems) {
        const now = it.el.getBoundingClientRect().top;
        const dy = (first.get(it.row.nickname) || now) - now;
        it.el.style.animation = 'none';
        it.el.style.transform = 'translateY(' + dy + 'px)';
        setRowRank(it.el, it.row.rank);
      }
      if (fixedIt) setRowRank(fixedIt.el, fixedIt.row.rank);
      void listEl.offsetHeight; // reflow
      for (const it of flowItems) {
        it.el.classList.add('moving');
        it.el.style.transform = '';
      }
      setTimeout(() => {
        if (token.cancelled) return;
        for (const it of flowItems) it.el.classList.remove('moving');
      }, 650);
    }, stagger + 700);
  }, 950);
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
