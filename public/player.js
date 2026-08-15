/* BaBaBo Quiz - oyuncu istemcisi */
'use strict';

const VIEWS = ['v-join', 'v-lobby', 'v-wager', 'v-question', 'v-waiting', 'v-result', 'v-leaderboard', 'v-final', 'v-info'];
const socket = io();

let session = null; // { pin, token, nickname }
let current = { index: null, answered: false, type: null };
let myScore = 0;

const timer = makeTimer(
  (remain, total) => renderTimer($('timerFill'), $('timerNum'), remain, total),
  () => {
    // Sure doldu: girisleri kilitle, sonucun gelmesini bekle
    lockQuestionInputs();
  }
);

/* ------------------------------------------------ oturum sakla/yukle */

function saveSession() {
  try { localStorage.setItem('cq_session', JSON.stringify(session)); } catch (e) {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem('cq_session') || 'null'); } catch (e) { return null; }
}
function clearSession() {
  session = null;
  try { localStorage.removeItem('cq_session'); } catch (e) {}
}

/* ------------------------------------------------------------ katilim */

function setMeBar() {
  if (session) {
    show($('meBar'));
    show($('topLogo'));
    $('meName').textContent = session.nickname;
    $('meScore').textContent = fmtPts(myScore);
  } else {
    hide($('meBar'));
    hide($('topLogo'));
  }
}

function renderTeams(players) {
  const grid = $('teamGrid');
  if (!grid) return;
  const list = (players || []).slice(0, 200);
  grid.innerHTML = list.map((p) => (
    '<span class="team-chip' + (p.connected ? '' : ' off') + (session && p.nickname === session.nickname ? ' me' : '') + '">' +
      '<span class="dot"></span>' + esc(p.nickname) +
    '</span>'
  )).join('');
}

function joinError(msg) {
  const box = $('joinErr');
  box.textContent = msg;
  show(box);
}

function doJoin(pin, nickname, token, silent) {
  socket.emit('player:join', { pin, nickname, token }, (res) => {
    if (!res || res.error) {
      if (!silent) joinError(res ? res.error : 'Sunucuya ulaşılamadı.');
      if (silent) {
        clearSession();
        const up = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '').slice(0, 6);
        if (up) $('inPin').value = up;
        showView(VIEWS, 'v-join');
      }
      return;
    }
    session = { pin, token: res.token, nickname: res.nickname };
    saveSession();
    applySnapshot(res.snapshot);
  });
}

$('btnJoin').addEventListener('click', () => {
  hide($('joinErr'));
  const pin = $('inPin').value.replace(/\D/g, '');
  const name = $('inName').value.trim();
  if (pin.length !== 6) { joinError('6 haneli PIN kodunu yaz.'); return; }
  if (!name) { joinError('Bir takım adı yaz.'); return; }
  doJoin(pin, name, null, false);
});

$('inPin').addEventListener('input', () => {
  $('inPin').value = $('inPin').value.replace(/\D/g, '').slice(0, 6);
});

$('btnInfoHome').addEventListener('click', () => {
  clearSession();
  myScore = 0;
  setMeBar();
  showView(VIEWS, 'v-join');
});

// Oyundan cik: skor sunucuda durur, ayni takim adiyla geri donulebilir
$('btnLeave').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = 'Emin misin?';
    btn.style.color = 'var(--bad)';
    setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Çık'; btn.style.color = 'var(--ink-3)'; }, 2500);
    return;
  }
  delete btn.dataset.confirm;
  btn.textContent = 'Çık';
  btn.style.color = 'var(--ink-3)';
  const old = session;
  clearSession();
  myScore = 0;
  timer.stop();
  if (old) socket.emit('player:leave', { pin: old.pin, token: old.token }, () => {});
  setMeBar();
  $('inPin').value = '';
  $('inName').value = '';
  showView(VIEWS, 'v-join');
});

/* --------------------------------------------------- anlik goruntu */

function applySnapshot(snap) {
  if (!snap) return;
  myScore = snap.you ? snap.you.score : 0;
  setMeBar();

  if (snap.state === 'lobby') {
    $('lobbyTitle').textContent = snap.title;
    $('lobbyName').textContent = session.nickname;
    $('lobbyCount').textContent = snap.lobby ? snap.lobby.count : 1;
    renderTeams(snap.lobby ? snap.lobby.players : []);
    showView(VIEWS, 'v-lobby');
  } else if (snap.state === 'wager' && snap.wager) {
    renderWager(snap.wager);
  } else if (snap.state === 'question' && snap.question) {
    renderQuestion(snap.question, snap.answered);
  } else if (snap.state === 'reveal' && snap.result) {
    renderResult(snap.result);
  } else if (snap.state === 'leaderboard' && snap.leaderboardData) {
    renderLeaderboard(snap.leaderboardData, true);
  } else if (snap.state === 'ended' && snap.final) {
    renderFinal(snap.final);
  } else {
    $('lobbyTitle').textContent = snap.title || '';
    $('lobbyName').textContent = session ? session.nickname : '';
    showView(VIEWS, 'v-lobby');
  }
}

/* ------------------------------------------------------------- risk */

let wagerState = null; // { index, maxWager }

function renderWager(w) {
  timer.stop();
  wagerState = { index: w.index, maxWager: w.maxWager };
  $('wgCatLine').textContent = w.category
    ? 'Sıradaki sorunun kategorisi: ' + w.category
    : 'Sıradaki soru için riskini belirle';
  $('wgScore').textContent = fmtPts(w.score);

  if (w.forced != null) {
    hide($('wgForm'));
    show($('wgForced'));
    $('wgForcedText').textContent = 'Puanın olmadığı için bu turda ' + fmtPts(w.forced) + ' puan için oynuyorsun.';
  } else {
    show($('wgForm'));
    hide($('wgForced'));
    $('wgInput').value = w.current != null ? w.current : '';
    $('wgStatus').textContent = w.current != null
      ? 'Riskin alındı: ' + fmtPts(w.current) + ' puan. Soru açılana kadar değiştirebilirsin.'
      : 'En az 1, en fazla ' + fmtPts(w.maxWager) + ' puan.';
  }
  showView(VIEWS, 'v-wager');
  if (w.forced == null) setTimeout(() => $('wgInput').focus(), 250);
}

for (const b of document.querySelectorAll('.wg-quick')) {
  b.addEventListener('click', () => {
    if (!wagerState) return;
    const f = Number(b.dataset.f);
    $('wgInput').value = Math.max(1, Math.floor(wagerState.maxWager * f));
  });
}

$('wgInput').addEventListener('input', () => {
  $('wgInput').value = $('wgInput').value.replace(/\D/g, '').slice(0, 9);
});

$('wgSubmit').addEventListener('click', () => {
  if (!wagerState) return;
  const amt = Math.round(Number($('wgInput').value));
  if (!Number.isFinite(amt) || amt < 1) { toast('En az 1 puan riske etmelisin.', true); return; }
  if (amt > wagerState.maxWager) { toast('En fazla ' + fmtPts(wagerState.maxWager) + ' puan riske edebilirsin.', true); return; }
  socket.emit('player:wager', { pin: session.pin, token: session.token, index: wagerState.index, amount: amt }, (res) => {
    if (!res || res.error) { toast(res ? res.error : 'Sunucuya ulaşılamadı.', true); return; }
    $('wgStatus').textContent = 'Riskin alındı: ' + fmtPts(res.amount) + ' puan. Soru açılana kadar değiştirebilirsin.';
  });
});

socket.on('wager:start', (w) => renderWager(w));

/* ------------------------------------------------------------- soru */

function lockQuestionInputs() {
  for (const b of document.querySelectorAll('#optGrid .opt-btn')) b.disabled = true;
  $('fibInput').disabled = true;
  const btn = document.querySelector('#fibForm button');
  if (btn) btn.disabled = true;
}

function renderQuestion(q, alreadyAnswered) {
  wagerState = null;
  current = { index: q.index, answered: !!alreadyAnswered, type: q.type };
  $('qNo').textContent = (q.index + 1) + ' / ' + q.total;
  if (q.risk) {
    const w = q.yourWager;
    if (w && w.zero) $('qPts').textContent = 'Risk yok, ' + fmtPts(w.plays) + ' için oynuyorsun';
    else if (w) $('qPts').textContent = 'Riskin: ' + fmtPts(w.amount);
    else $('qPts').textContent = 'RİSK';
    $('qPts').parentElement.style.borderColor = 'rgba(227,196,127,0.5)';
  } else if (q.type === 'trap') {
    $('qPts').textContent = fmtPts(q.points) + ' puan | Dikkat, tuzak var!';
    $('qPts').parentElement.style.borderColor = 'rgba(239,111,111,0.5)';
  } else {
    $('qPts').textContent = fmtPts(q.points) + ' puan';
    $('qPts').parentElement.style.borderColor = '';
  }
  $('qText').textContent = q.text;

  const grid = $('optGrid');
  const fib = $('fibForm');
  grid.innerHTML = '';

  if (q.type !== 'fib') {
    show(grid); hide(fib);
    grid.classList.toggle('single', q.options.length <= 3 && q.options.some((o) => o.length > 24));
    q.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'opt-btn opt-c' + ((i % 6) + 1);
      b.innerHTML = shapeSpan(i) + '<span>' + esc(opt) + '</span>';
      b.addEventListener('click', () => submitAnswer(i, b));
      grid.appendChild(b);
    });
  } else {
    hide(grid); show(fib);
    $('fibInput').value = '';
    $('fibInput').disabled = false;
    document.querySelector('#fibForm button').disabled = false;
  }

  if (q.endsAt) {
    timer.start(q.endsAt, q.serverNow, q.timeLimit);
  } else {
    timer.stop();
    renderTimer($('timerFill'), $('timerNum'), null, null);
  }

  if (current.answered) {
    showView(VIEWS, 'v-waiting');
  } else {
    showView(VIEWS, 'v-question');
    if (q.type === 'fib') setTimeout(() => $('fibInput').focus(), 250);
  }
}

function submitAnswer(value, clickedBtn) {
  if (current.answered) return;
  current.answered = true;

  if (current.type !== 'fib') {
    for (const b of document.querySelectorAll('#optGrid .opt-btn')) {
      b.disabled = true;
      if (b !== clickedBtn) b.classList.add('dim');
    }
    if (clickedBtn) clickedBtn.classList.add('picked');
  }

  socket.emit('player:answer', { pin: session.pin, token: session.token, index: current.index, value }, (res) => {
    if (res && res.error) {
      toast(res.error, true);
      if (current.type === 'fib') {
        current.answered = false;
        return;
      }
    }
    setTimeout(() => {
      // Bu arada sonuc ekrani geldiyse dokunma
      if (current.answered && !$('v-question').classList.contains('hidden')) {
        showView(VIEWS, 'v-waiting');
      }
    }, current.type !== 'fib' ? 350 : 0);
  });
}

$('fibForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('fibInput').value.trim();
  if (!v) { toast('Önce cevabını yaz.', true); return; }
  submitAnswer(v, null);
});

/* ------------------------------------------------------------ sonuc */

function renderResult(r) {
  timer.stop();
  myScore = r.score;
  setMeBar();

  const v = $('resVerdict');
  if (!r.answered) {
    v.textContent = 'Cevap vermedin';
    v.className = 'verdict meh';
  } else if (r.correct) {
    v.textContent = 'DOĞRU!';
    v.className = 'verdict ok';
  } else if (r.trapped) {
    v.textContent = 'TUZAĞA DÜŞTÜN!';
    v.className = 'verdict no';
  } else {
    v.textContent = 'YANLIŞ';
    v.className = 'verdict no';
  }
  $('resGain').textContent = (r.gain > 0 ? '+' : '') + fmtPts(r.gain) + ' puan';
  $('resGain').style.color = r.gain < 0 ? 'var(--bad)' : '';
  $('resScore').textContent = fmtPts(r.score);
  $('resRank').textContent = r.rank ? r.rank + ' / ' + r.playerCount : '-';

  const box = $('resAnswerBox');
  let html = '';
  if (r.answered && !r.correct && r.yourAnswer != null) {
    html += '<div class="muted tiny" style="margin-bottom:4px;">Senin cevabın: ' + esc(String(r.yourAnswer)) + '</div>';
  }
  if (r.correctDisplay) {
    if (r.correctDisplay.type === 'mc') {
      html += 'Doğru cevap: ' + r.correctDisplay.texts.map(esc).join(' / ');
      if (r.correctDisplay.trapTexts && r.correctDisplay.trapTexts.length) {
        html += '<div style="margin-top:4px; color:#f3a1a1;">Tuzak: ' + r.correctDisplay.trapTexts.map(esc).join(' / ') + '</div>';
      }
    } else {
      html += 'Doğru cevap: ' + r.correctDisplay.answers.slice(0, 3).map(esc).join(' / ');
    }
  }
  if (html) { box.innerHTML = html; show(box); } else { hide(box); }

  showView(VIEWS, 'v-result');
}

/* ----------------------------------------------------- skor tablosu */

let lastAnimatedLb = -1;

function renderLeaderboard(data, forceStatic) {
  timer.stop();
  myScore = data.you ? data.you.score : myScore;
  setMeBar();
  $('lbProgress').textContent = (data.questionIndex + 1) + '. soru sonrası' + (data.isLast ? ' (son soru)' : '');

  const animate = !forceStatic && data.questionIndex !== lastAnimatedLb;
  if (animate) lastAnimatedLb = data.questionIndex;

  const youRow = (data.you && data.you.rank)
    ? { rank: data.you.rank, prevRank: data.you.prevRank, nickname: session.nickname, score: data.you.score, prevScore: data.you.prevScore, gain: data.you.gain }
    : null;

  showView(VIEWS, 'v-leaderboard');
  renderLeaderboardAnimated($('lbList'), data.top, {
    animate,
    isMe: (n) => session && n === session.nickname,
    youRow,
  });
}

/* ------------------------------------------------------------- final */

function renderFinal(f) {
  timer.stop();
  myScore = f.you ? f.you.score : myScore;
  setMeBar();

  const cols = [];
  const medals = ['1', '2', '3'];
  const order = [1, 0, 2]; // 2. - 1. - 3. seklinde diz
  for (const oi of order) {
    const p = f.podium[oi];
    if (!p) continue;
    cols.push('<div class="col col' + (oi + 1) + '" style="animation-delay:' + (oi * 150) + 'ms">' +
      '<div class="who">' + esc(p.nickname) + '</div>' +
      '<div class="score num">' + fmtPts(p.score) + '</div>' +
      '<div class="box"><div class="medal">' + medals[oi] + '.</div></div>' +
      '</div>');
  }
  $('podium').innerHTML = cols.join('');

  if (f.you && f.you.rank) {
    $('finalYou').textContent = 'Sıralaman: ' + f.you.rank + ' / ' + f.playerCount + ' (' + fmtPts(f.you.score) + ' puan)';
  } else {
    $('finalYou').textContent = '';
  }
  $('finalMeta').textContent = f.title;
  showView(VIEWS, 'v-final');
}

/* --------------------------------------------------- sunucu olaylari */

socket.on('lobby:update', (d) => {
  $('lobbyCount').textContent = d.count;
  if (!$('v-lobby').classList.contains('hidden')) renderTeams(d.players);
});

socket.on('question:start', (q) => renderQuestion(q, false));
socket.on('question:result', (r) => renderResult(r));
socket.on('leaderboard', (d) => renderLeaderboard(d));
socket.on('game:ended', (f) => renderFinal(f));

socket.on('player:kicked', () => {
  clearSession();
  timer.stop();
  $('infoTitle').textContent = 'Oyundan çıkarıldın';
  $('infoText').textContent = 'Sunucu seni oyundan çıkardı.';
  showView(VIEWS, 'v-info');
});

socket.on('game:cancelled', (d) => {
  clearSession();
  timer.stop();
  $('infoTitle').textContent = 'Oyun sonlandırıldı';
  $('infoText').textContent = d && d.reason ? d.reason : 'Sunucu oyunu kapattı.';
  showView(VIEWS, 'v-info');
});

/* ------------------------------------------- baglanti / kurtarma */

socket.on('disconnect', () => show($('connBanner')));

socket.on('connect', () => {
  hide($('connBanner'));
  if (session) {
    // Kaldigi yerden devam et
    doJoin(session.pin, session.nickname, session.token, true);
  }
});

/* ------------------------------------------------------- baslangic */

(function init() {
  const params = new URLSearchParams(location.search);
  const urlPin = (params.get('pin') || '').replace(/\D/g, '').slice(0, 6);

  const saved = loadSession();
  if (saved && saved.pin && saved.token && (!urlPin || urlPin === saved.pin)) {
    // Dogrudan token ile geri don; oyun bitmis olsa bile final ekrani gelir.
    session = saved;
    doJoin(saved.pin, saved.nickname, saved.token, true);
    return;
  }
  if (urlPin) {
    $('inPin').value = urlPin;
    socket.emit('game:exists', { pin: urlPin }, (res) => {
      if (res && res.ok && res.title) $('joinSub').textContent = res.title + ' | Takım adını yaz ve katıl';
    });
    $('inName').focus();
  }
  showView(VIEWS, 'v-join');
})();
