/* BaBaBo Quiz - host (sunucu) istemcisi: quiz editoru + oyun yonetimi */
'use strict';

const VIEWS = ['v-login', 'v-dash', 'v-editor', 'v-stage'];
const STAGES = ['s-lobby', 's-question', 's-reveal', 's-leaderboard', 's-final'];
const socket = io();

let password = sessionStorage.getItem('cq_pw') || null;
let quizzes = loadQuizzes();
let editingId = null;
let saveTimer = null;

let game = null; // { pin, hostToken }
let stage = { state: null, quiz: null, currentIndex: -1, lastFinal: null };

const hostTimer = makeTimer(
  (remain, total) => {
    renderTimer($('hTimerFill'), $('hTimerNum'), remain, total);
    tickSound(remain);
  },
  () => {}
);

/* ------------------------------------------------------------ depo */

function loadQuizzes() {
  try {
    const v = JSON.parse(localStorage.getItem('cq_quizzes_v1') || 'null');
    if (Array.isArray(v)) return v;
  } catch (e) {}
  return null;
}

function persistQuizzes() {
  try { localStorage.setItem('cq_quizzes_v1', JSON.stringify(quizzes)); } catch (e) {}
}

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

function demoQuiz() {
  return {
    id: uid(),
    title: 'Örnek Quiz (denemek için)',
    updatedAt: Date.now(),
    questions: [
      { type: 'mc', text: "Türkiye'nin başkenti neresidir?", points: 100, timeLimit: 20,
        options: ['Ankara', 'İstanbul', 'İzmir', 'Bursa'], correct: [0] },
      { type: 'mc', text: "Doğru mu yanlış mı: Dünya, Güneş'ten büyüktür.", points: 50, timeLimit: 15,
        options: ['Doğru', 'Yanlış'], correct: [1] },
      { type: 'fib', text: "İstiklal Marşı'nın şairi kimdir? (Ad Soyad yaz)", points: 200, timeLimit: 30,
        accepted: ['Mehmet Akif Ersoy', 'Mehmet Akif'], caseSensitive: false, typoTolerance: true },
      { type: 'mc', text: 'Hangisi bir gezegen değildir?', points: 150, timeLimit: 20,
        options: ['Mars', 'Venüs', 'Ay', 'Jüpiter'], correct: [2] },
    ],
  };
}

if (!quizzes) {
  quizzes = [demoQuiz()];
  persistQuizzes();
}

function blankQuestion(type) {
  if (type === 'fib') {
    return { type: 'fib', text: '', points: 100, timeLimit: 20, accepted: [], caseSensitive: false, typoTolerance: false };
  }
  return { type: 'mc', text: '', points: 100, timeLimit: 20, options: ['', '', '', ''], correct: [] };
}

function getQuiz(id) { return quizzes.find((q) => q.id === id); }

/* ------------------------------------------------------------ giris */

function tryLogin(pw, cb) {
  socket.emit('host:login', { password: pw }, (res) => cb(res && res.ok, res && res.error));
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  hide($('loginErr'));
  const pw = $('inPassword').value;
  tryLogin(pw, (ok, err) => {
    if (!ok) { $('loginErr').textContent = err || 'Giriş yapılamadı.'; show($('loginErr')); return; }
    password = pw;
    sessionStorage.setItem('cq_pw', pw);
    renderDash();
    showView(VIEWS, 'v-dash');
  });
});

/* --------------------------------------------------------- panel */

function quizSummary(q) {
  const total = q.questions.reduce((s, x) => s + (Number(x.points) || 0), 0);
  return q.questions.length + ' soru | toplam ' + fmtPts(total) + ' puan';
}

function renderDash() {
  const grid = $('dashGrid');
  if (!quizzes.length) {
    grid.innerHTML = '<div class="card muted">Henüz quiz yok. "Yeni Quiz" ile başla.</div>';
    return;
  }
  grid.innerHTML = quizzes.map((q) => (
    '<div class="card quiz-card" data-id="' + q.id + '">' +
      '<h3>' + esc(q.title || 'Adsız Quiz') + '</h3>' +
      '<p class="muted tiny">' + quizSummary(q) + '</p>' +
      '<div class="actions">' +
        '<button class="btn btn-primary btn-sm" data-act="start">Başlat</button>' +
        '<button class="btn btn-sm" data-act="edit">Düzenle</button>' +
        '<button class="btn btn-sm" data-act="copy">Kopyala</button>' +
        '<button class="btn btn-sm" data-act="export">İndir</button>' +
        '<button class="btn btn-sm btn-danger" data-act="del">Sil</button>' +
      '</div>' +
    '</div>'
  )).join('');
}

$('dashGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.quiz-card').dataset.id;
  const quiz = getQuiz(id);
  if (!quiz) return;
  const act = btn.dataset.act;
  if (act === 'edit') { openEditor(id); }
  else if (act === 'start') { startGame(quiz); }
  else if (act === 'copy') {
    const c = JSON.parse(JSON.stringify(quiz));
    c.id = uid(); c.title = quiz.title + ' (kopya)'; c.updatedAt = Date.now();
    quizzes.unshift(c); persistQuizzes(); renderDash();
  }
  else if (act === 'export') { exportQuiz(quiz); }
  else if (act === 'del') {
    if (btn.dataset.confirm) {
      quizzes = quizzes.filter((q) => q.id !== id);
      persistQuizzes(); renderDash();
    } else {
      btn.dataset.confirm = '1';
      btn.textContent = 'Emin misin?';
      setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Sil'; }, 2500);
    }
  }
});

$('btnNewQuiz').addEventListener('click', () => {
  const q = { id: uid(), title: '', updatedAt: Date.now(), questions: [blankQuestion('mc')] };
  quizzes.unshift(q);
  persistQuizzes();
  openEditor(q.id);
});

$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const qs = Array.isArray(data.questions) ? data.questions : null;
      if (!qs) throw new Error('questions yok');
      const quiz = { id: uid(), title: String(data.title || 'İçe aktarılan quiz').slice(0, 80), updatedAt: Date.now(), questions: [] };
      for (const rq of qs.slice(0, 150)) {
        const q = blankQuestion(rq.type === 'fib' ? 'fib' : 'mc');
        q.text = String(rq.text || '').slice(0, 400);
        q.points = Math.max(0, Math.round(Number(rq.points) || 100));
        q.timeLimit = Math.max(0, Math.round(Number(rq.timeLimit) || 0));
        if (q.type === 'mc') {
          q.options = (Array.isArray(rq.options) ? rq.options : []).map((o) => String(o).slice(0, 160)).slice(0, 6);
          while (q.options.length < 2) q.options.push('');
          q.correct = (Array.isArray(rq.correct) ? rq.correct : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
        } else {
          q.accepted = (Array.isArray(rq.accepted) ? rq.accepted : []).map((a) => String(a).slice(0, 100)).slice(0, 30);
          q.caseSensitive = !!rq.caseSensitive;
          q.typoTolerance = !!rq.typoTolerance;
        }
        quiz.questions.push(q);
      }
      if (!quiz.questions.length) throw new Error('soru yok');
      quizzes.unshift(quiz);
      persistQuizzes();
      renderDash();
      toast('Quiz içe aktarıldı: ' + quiz.title);
    } catch (err) {
      toast('Dosya okunamadı. Geçerli bir quiz JSON dosyası seç.', true);
    }
  };
  reader.readAsText(f, 'utf-8');
});

function exportQuiz(quiz) {
  const data = { title: quiz.title, questions: quiz.questions };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (quiz.title || 'quiz').replace(/[^\wçğıöşüÇĞİÖŞÜ -]/g, '').trim().replace(/\s+/g, '-') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ----------------------------------------------------------- editor */

function openEditor(id) {
  editingId = id;
  const quiz = getQuiz(id);
  $('edTitle').value = quiz.title;
  renderEditor();
  showView(VIEWS, 'v-editor');
}

function markSaved() {
  $('saveState').textContent = 'Kaydedildi';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saveState').textContent = ''; }, 1500);
}

function saveEditing() {
  const quiz = getQuiz(editingId);
  if (!quiz) return;
  quiz.updatedAt = Date.now();
  persistQuizzes();
  markSaved();
}

function optColorStyle(i) {
  return 'background:' + OPT_COLORS[i % 6] + '; color:' + OPT_INKS[i % 6] + ';';
}

function renderEditor() {
  const quiz = getQuiz(editingId);
  const wrap = $('qEditor');
  wrap.innerHTML = quiz.questions.map((q, qi) => {
    let body = '';
    if (q.type === 'mc') {
      body = q.options.map((opt, oi) => (
        '<div class="opt-edit-row">' +
          '<span class="mini-shape" style="' + optColorStyle(oi) + '">' + OPT_SHAPES[oi % 6] + '</span>' +
          '<input class="input" data-qi="' + qi + '" data-field="option" data-oi="' + oi + '" maxlength="160" placeholder="' + (oi + 1) + '. şık" value="' + esc(opt) + '">' +
          '<button class="correct-toggle' + (q.correct.includes(oi) ? ' on' : '') + '" data-qi="' + qi + '" data-act="correct" data-oi="' + oi + '" title="Doğru cevap olarak işaretle">&#10003;</button>' +
          (q.options.length > 2 ? '<button class="icon-btn" data-qi="' + qi + '" data-act="rmopt" data-oi="' + oi + '" title="Şıkkı sil">&#215;</button>' : '') +
        '</div>'
      )).join('') +
      (q.options.length < 6 ? '<button class="btn btn-sm" style="margin-top:10px;" data-qi="' + qi + '" data-act="addopt">+ Şık ekle</button>' : '') +
      '<p class="tiny" style="margin-top:8px;">Doğru şıkkın yanındaki onay işaretini yeşile getir. Birden fazla doğru işaretlersen, herhangi birini seçen puan alır.</p>';
    } else {
      body =
        '<div class="qe-mini-label" style="margin-top:6px;">Kabul edilen cevaplar (her satıra bir tane)</div>' +
        '<textarea class="input" rows="3" data-qi="' + qi + '" data-field="accepted" placeholder="Örn:\nMehmet Akif Ersoy\nMehmet Akif">' + esc((q.accepted || []).join('\n')) + '</textarea>' +
        '<label class="check-line"><input type="checkbox" data-qi="' + qi + '" data-field="typoTolerance"' + (q.typoTolerance ? ' checked' : '') + '> 1 harflik yazım hatasını kabul et</label>' +
        '<label class="check-line"><input type="checkbox" data-qi="' + qi + '" data-field="caseSensitive"' + (q.caseSensitive ? ' checked' : '') + '> Büyük/küçük harfe duyarlı olsun</label>';
    }
    return (
      '<div class="card qe-card">' +
        '<div class="qe-head">' +
          '<span class="qe-num">' + (qi + 1) + '.</span>' +
          '<span class="chip">' + (q.type === 'mc' ? 'Çoktan Seçmeli' : 'Boşluk Doldurma') + '</span>' +
          '<span class="grow"></span>' +
          '<div><div class="qe-mini-label">Puan</div><input type="number" min="0" max="1000000" step="10" class="input qe-mini" data-qi="' + qi + '" data-field="points" value="' + q.points + '"></div>' +
          '<div><div class="qe-mini-label">Süre (sn, 0 = süresiz)</div><input type="number" min="0" max="600" step="5" class="input qe-mini" data-qi="' + qi + '" data-field="timeLimit" value="' + q.timeLimit + '"></div>' +
          '<button class="icon-btn" data-qi="' + qi + '" data-act="up" title="Yukarı taşı">&#8593;</button>' +
          '<button class="icon-btn" data-qi="' + qi + '" data-act="down" title="Aşağı taşı">&#8595;</button>' +
          '<button class="icon-btn" data-qi="' + qi + '" data-act="dup" title="Soruyu kopyala">&#10697;</button>' +
          '<button class="icon-btn" data-qi="' + qi + '" data-act="rmq" title="Soruyu sil" style="color:#f87171;">&#215;</button>' +
        '</div>' +
        '<textarea class="input" rows="2" maxlength="400" data-qi="' + qi + '" data-field="text" placeholder="Soru metni...">' + esc(q.text) + '</textarea>' +
        body +
      '</div>'
    );
  }).join('');
}

$('edTitle').addEventListener('input', () => {
  const quiz = getQuiz(editingId);
  if (!quiz) return;
  quiz.title = $('edTitle').value;
  saveEditing();
});

$('qEditor').addEventListener('input', (e) => {
  const el = e.target;
  const qi = Number(el.dataset.qi);
  const quiz = getQuiz(editingId);
  if (!quiz || !Number.isInteger(qi)) return;
  const q = quiz.questions[qi];
  if (!q) return;
  const field = el.dataset.field;
  if (field === 'text') q.text = el.value;
  else if (field === 'points') q.points = Math.max(0, Math.round(Number(el.value) || 0));
  else if (field === 'timeLimit') q.timeLimit = Math.max(0, Math.min(600, Math.round(Number(el.value) || 0)));
  else if (field === 'option') q.options[Number(el.dataset.oi)] = el.value;
  else if (field === 'accepted') q.accepted = el.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30);
  else if (field === 'typoTolerance') q.typoTolerance = el.checked;
  else if (field === 'caseSensitive') q.caseSensitive = el.checked;
  saveEditing();
});

$('qEditor').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const quiz = getQuiz(editingId);
  if (!quiz) return;
  const qi = Number(btn.dataset.qi);
  const q = quiz.questions[qi];
  const act = btn.dataset.act;

  if (act === 'correct') {
    const oi = Number(btn.dataset.oi);
    const pos = q.correct.indexOf(oi);
    if (pos >= 0) q.correct.splice(pos, 1); else q.correct.push(oi);
    btn.classList.toggle('on', q.correct.includes(oi));
    saveEditing();
    return; // yeniden cizime gerek yok
  }
  if (act === 'addopt') { q.options.push(''); }
  else if (act === 'rmopt') {
    const oi = Number(btn.dataset.oi);
    q.options.splice(oi, 1);
    q.correct = q.correct.filter((c) => c !== oi).map((c) => (c > oi ? c - 1 : c));
  }
  else if (act === 'up' && qi > 0) { quiz.questions.splice(qi - 1, 0, quiz.questions.splice(qi, 1)[0]); }
  else if (act === 'down' && qi < quiz.questions.length - 1) { quiz.questions.splice(qi + 1, 0, quiz.questions.splice(qi, 1)[0]); }
  else if (act === 'dup') { quiz.questions.splice(qi + 1, 0, JSON.parse(JSON.stringify(q))); }
  else if (act === 'rmq') {
    if (quiz.questions.length <= 1) { toast('En az bir soru kalmalı.', true); return; }
    quiz.questions.splice(qi, 1);
  }
  else return;
  saveEditing();
  renderEditor();
});

$('btnAddMc').addEventListener('click', () => {
  const quiz = getQuiz(editingId);
  quiz.questions.push(blankQuestion('mc'));
  saveEditing(); renderEditor();
  window.scrollTo(0, document.body.scrollHeight);
});
$('btnAddFib').addEventListener('click', () => {
  const quiz = getQuiz(editingId);
  quiz.questions.push(blankQuestion('fib'));
  saveEditing(); renderEditor();
  window.scrollTo(0, document.body.scrollHeight);
});

$('btnBackDash').addEventListener('click', () => { renderDash(); showView(VIEWS, 'v-dash'); });
$('btnStartFromEditor').addEventListener('click', () => {
  const quiz = getQuiz(editingId);
  if (quiz) startGame(quiz);
});

/* ------------------------------------------------- oyun baslatma */

function validateQuiz(quiz) {
  if (!quiz.questions.length) return 'Quizde soru yok.';
  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    if (!String(q.text || '').trim()) return (i + 1) + '. sorunun metni boş.';
    if (q.type === 'mc') {
      const filled = q.options.map((o, oi) => ({ o: String(o || '').trim(), oi })).filter((x) => x.o);
      if (filled.length < 2) return (i + 1) + '. soruda en az 2 dolu şık olmalı.';
      const filledIdx = filled.map((x) => x.oi);
      if (!q.correct.some((c) => filledIdx.includes(c))) return (i + 1) + '. soruda doğru şık işaretlenmemiş.';
    } else {
      if (!(q.accepted || []).length) return (i + 1) + '. soru için kabul edilen cevap girilmemiş.';
    }
  }
  return null;
}

// Sunucuya gonderilecek bicime cevir (bos siklari at, dogru indekslerini kaydir)
function packQuiz(quiz) {
  return {
    title: quiz.title || 'Adsız Quiz',
    questions: quiz.questions.map((q) => {
      if (q.type === 'mc') {
        const keep = [];
        q.options.forEach((o, oi) => { if (String(o || '').trim()) keep.push(oi); });
        return {
          type: 'mc', text: q.text, points: q.points, timeLimit: q.timeLimit,
          options: keep.map((oi) => q.options[oi]),
          correct: q.correct.filter((c) => keep.includes(c)).map((c) => keep.indexOf(c)),
        };
      }
      return {
        type: 'fib', text: q.text, points: q.points, timeLimit: q.timeLimit,
        accepted: q.accepted, caseSensitive: q.caseSensitive, typoTolerance: q.typoTolerance,
      };
    }),
  };
}

function startGame(quiz) {
  const err = validateQuiz(quiz);
  if (err) { toast(err, true); openEditor(quiz.id); return; }
  socket.emit('host:create', { password, quiz: packQuiz(quiz) }, (res) => {
    if (!res || res.error) { toast(res ? res.error : 'Sunucuya ulaşılamadı.', true); return; }
    game = { pin: res.pin, hostToken: res.hostToken };
    try { localStorage.setItem('cq_host_session', JSON.stringify(game)); } catch (e) {}
    applyHostSnapshot(res.snapshot);
    showView(VIEWS, 'v-stage');
  });
}

function leaveGame() {
  game = null;
  stage = { state: null, quiz: null, currentIndex: -1, lastFinal: null };
  hostTimer.stop();
  try { localStorage.removeItem('cq_host_session'); } catch (e) {}
  renderDash();
  showView(VIEWS, 'v-dash');
}

/* ------------------------------------------------------- sahne */

function hostAction(event, extra, cb) {
  socket.emit(event, Object.assign({ pin: game.pin, hostToken: game.hostToken }, extra || {}), (res) => {
    if (res && res.error) toast(res.error, true);
    if (cb) cb(res);
  });
}

function setStage(id) {
  for (const s of STAGES) { if (s === id) show($(s)); else hide($(s)); }
}

function stageButtons(list) {
  const bar = $('stageBar');
  bar.innerHTML = '';
  for (const b of list) {
    const el = document.createElement('button');
    el.className = 'btn btn-big' + (b.primary ? ' btn-primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    bar.appendChild(el);
  }
}

function applyHostSnapshot(snap) {
  stage.quiz = snap.quiz;
  stage.currentIndex = snap.currentIndex;
  $('stTitle').textContent = snap.quiz.title;
  $('stPin').textContent = snap.pin;
  updateConn(snap.lobby);

  if (snap.state === 'lobby') renderStageLobby(snap.lobby);
  else if (snap.state === 'question') renderStageQuestion(snap.question);
  else if (snap.state === 'reveal') renderStageReveal(snap.reveal);
  else if (snap.state === 'leaderboard') renderStageLeaderboard(snap.leaderboardData, true);
  else if (snap.state === 'ended') renderStageFinal(snap.final);
}

function updateConn(lobby) {
  if (!lobby) return;
  $('stConn').textContent = lobby.connected;
  $('lobbyCount2').textContent = lobby.count;
}

/* --- lobi --- */

function renderStageLobby(lobby) {
  stage.state = 'lobby';
  const url = location.origin;
  $('joinUrl').textContent = url.replace(/^https?:\/\//, '');
  $('bigPin').textContent = game.pin;

  try {
    const qr = qrcode(0, 'M');
    qr.addData(url + '/?pin=' + game.pin);
    qr.make();
    $('qrBox').innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  } catch (e) {
    $('qrBox').innerHTML = '';
  }

  renderPlayerChips(lobby ? lobby.players : []);
  updateConn(lobby);
  setStage('s-lobby');
  stageButtons([
    { label: 'Oyunu Başlat', primary: true, onClick: () => {
      const count = Number($('lobbyCount2').textContent);
      if (count > 0 || $('lobbyCount2').dataset.force === '1') {
        delete $('lobbyCount2').dataset.force;
        hostAction('host:start_question', { index: 0 });
      } else {
        $('lobbyCount2').dataset.force = '1';
        toast('Henüz katılan takım yok. Yine de başlatmak için tekrar tıkla.', true);
      }
    } },
  ]);
}

function renderPlayerChips(players) {
  const wrap = $('playerChips');
  wrap.innerHTML = (players || []).map((p) => (
    '<span class="team-chip' + (p.connected ? '' : ' off') + '"><span class="dot"></span>' + esc(p.nickname) +
    (p.token ? '<button class="kick" data-token="' + p.token + '" title="Takımı çıkar">&#215;</button>' : '') +
    '</span>'
  )).join('');
}

$('playerChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.kick');
  if (!btn) return;
  hostAction('host:kick', { playerToken: btn.dataset.token });
});

/* --- soru --- */

function renderStageQuestion(q) {
  stage.state = 'question';
  stage.currentIndex = q.index;
  $('hQNo').textContent = (q.index + 1) + ' / ' + q.total;
  $('hQPts').textContent = fmtPts(q.points);
  $('hAnswered').textContent = '0 / ' + $('stConn').textContent;
  $('hQText').textContent = q.text;

  const grid = $('hOptGrid');
  grid.innerHTML = '';
  if (q.type === 'mc') {
    show(grid); hide($('hFibHint'));
    q.options.forEach((opt, i) => {
      const d = document.createElement('div');
      d.className = 'opt-btn opt-c' + ((i % 6) + 1);
      d.style.cursor = 'default';
      d.innerHTML = shapeSpan(i) + '<span>' + esc(opt) + '</span>';
      grid.appendChild(d);
    });
  } else {
    hide(grid); show($('hFibHint'));
  }

  if (q.endsAt) hostTimer.start(q.endsAt, q.serverNow, q.timeLimit);
  else { hostTimer.stop(); renderTimer($('hTimerFill'), $('hTimerNum'), null, null); }

  setStage('s-question');
  stageButtons([
    { label: 'Cevapları Kapat', primary: true, onClick: () => hostAction('host:close_question') },
  ]);
}

socket.on('progress', (p) => {
  $('hAnswered').textContent = p.answered + ' / ' + p.total;
});

/* --- sonuc / dagilim --- */

function distRowHtml(label, count, maxCount, colorCss, isCorrect, shapeIdx) {
  const pct = maxCount > 0 ? Math.max(2, Math.round((count / maxCount) * 100)) : 2;
  const color = colorCss || 'rgba(255,255,255,0.28)';
  return (
    '<div class="dist-row' + (isCorrect ? ' correct-row' : ' dimmed') + '">' +
      '<div class="dist-label">' +
        (shapeIdx == null ? '' : '<span class="mini-shape" style="' + optColorStyle(shapeIdx) + '">' + OPT_SHAPES[shapeIdx % 6] + '</span>') +
        '<span class="txt">' + label + '</span>' +
        (isCorrect ? '<span class="ok-mark">&#10003;</span>' : '') +
      '</div>' +
      '<div class="dist-track"><div class="dist-fill" style="width:' + pct + '%; background:' + color + ';"></div></div>' +
      '<div class="dist-count num">' + count + '</div>' +
    '</div>'
  );
}

function renderStageReveal(r) {
  stage.state = 'reveal';
  stage.currentIndex = r.index;
  const q = stage.quiz.questions[r.index];
  $('rQNo').textContent = (r.index + 1) + ' / ' + stage.quiz.questions.length;
  $('rAnswered').textContent = r.answeredCount + ' / ' + (r.playerCount != null ? r.playerCount : r.answeredCount);
  $('rQText').textContent = q ? q.text : '';

  const cd = r.correctDisplay;
  if (cd.type === 'mc') {
    $('rCorrect').innerHTML = 'Doğru cevap: <strong>' + cd.texts.map(esc).join(' / ') + '</strong>';
  } else {
    $('rCorrect').innerHTML = 'Doğru cevap: <strong>' + cd.answers.map(esc).join(' / ') + '</strong>';
  }

  const d = r.distribution;
  let rows = '';
  if (d.type === 'mc') {
    const max = Math.max(1, ...d.counts);
    rows = d.counts.map((c, i) => distRowHtml(esc(q.options[i]), c, max, OPT_COLORS[i % 6], cd.indices.includes(i), i)).join('');
    if (d.noAnswer > 0) rows += distRowHtml('Cevapsız', d.noAnswer, max, null, false, null);
  } else {
    const max = Math.max(1, ...d.top.map((b) => b.count), d.noAnswer || 0);
    rows = d.top.map((b) => distRowHtml(esc(b.text), b.count, max, b.correct ? '#22c55e' : null, b.correct, null)).join('');
    if (d.noAnswer > 0) rows += distRowHtml('Cevapsız', d.noAnswer, max, null, false, null);
    if (!d.top.length) rows = '<p class="centered muted">Hiç cevap gelmedi.</p>';
  }
  $('rDist').innerHTML = rows;

  const isLast = r.index >= stage.quiz.questions.length - 1;
  setStage('s-reveal');
  const btns = [{ label: 'Skor Tablosu', onClick: () => hostAction('host:show_leaderboard') }];
  if (isLast) btns.push({ label: 'Oyunu Bitir', primary: true, onClick: () => hostAction('host:end_game') });
  else btns.push({ label: 'Sonraki Soru', primary: true, onClick: () => hostAction('host:start_question', { index: r.index + 1 }) });
  stageButtons(btns);
  revealSound();
}

/* --- skor tablosu --- */

let lastAnimatedLb = -1;

function renderStageLeaderboard(data, forceStatic) {
  stage.state = 'leaderboard';
  $('hLbProgress').textContent = (data.questionIndex + 1) + '. soru sonrası' + (data.isLast ? ' (son soru)' : '');

  const animate = !forceStatic && data.questionIndex !== lastAnimatedLb;
  if (animate) lastAnimatedLb = data.questionIndex;

  if (!data.top.length) {
    $('hLbList').innerHTML = '<p class="centered muted">Henüz takım yok.</p>';
  } else {
    renderLeaderboardAnimated($('hLbList'), data.top, { animate });
  }

  setStage('s-leaderboard');
  const btns = [];
  if (data.isLast) btns.push({ label: 'Oyunu Bitir', primary: true, onClick: () => hostAction('host:end_game') });
  else btns.push({ label: 'Sonraki Soru', primary: true, onClick: () => hostAction('host:start_question', { index: data.questionIndex + 1 }) });
  stageButtons(btns);
}

/* --- final --- */

function renderStageFinal(f) {
  stage.state = 'ended';
  stage.lastFinal = f;
  $('hFinalTitle').textContent = f.title + ' | ' + f.playerCount + ' takım';

  const order = [1, 0, 2];
  let cols = '';
  for (const oi of order) {
    const p = f.podium[oi];
    if (!p) continue;
    cols += '<div class="col col' + (oi + 1) + '" style="animation-delay:' + (oi * 150) + 'ms">' +
      '<div class="who">' + esc(p.nickname) + '</div>' +
      '<div class="score num">' + fmtPts(p.score) + '</div>' +
      '<div class="box"><div class="medal">' + (oi + 1) + '.</div></div>' +
      '</div>';
  }
  $('hPodium').innerHTML = cols;

  const full = f.full || f.top || [];
  $('hFullTable').innerHTML = '<tr><th>Sıra</th><th>Takım</th><th>Puan</th></tr>' +
    full.map((r) => '<tr><td class="num">' + r.rank + '</td><td>' + esc(r.nickname) + '</td><td class="num">' + fmtPts(r.score) + '</td></tr>').join('');

  setStage('s-final');
  stageButtons([
    { label: 'Panele Dön', primary: true, onClick: leaveGame },
  ]);
  finalSound();
}

$('btnCsv').addEventListener('click', () => {
  const f = stage.lastFinal;
  if (!f) return;
  const full = f.full || f.top || [];
  const lines = ['Sıra;Takım;Puan'];
  for (const r of full) lines.push(r.rank + ';"' + String(r.nickname).replace(/"/g, '""') + '";' + r.score);
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'quiz-sonuclari.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('btnCancelGame').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm) {
    hostAction('host:cancel', null, () => leaveGame());
  } else {
    btn.dataset.confirm = '1';
    btn.textContent = 'Emin misin?';
    setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Oyunu Kapat'; }, 2500);
  }
});

/* ------------------------------------------------- sunucu olaylari */

socket.on('lobby:update:host', (lobby) => {
  updateConn(lobby);
  if (stage.state === 'lobby') renderPlayerChips(lobby.players);
});
socket.on('lobby:update', (lobby) => {
  // host odada oldugu icin genel yayini da alir; sayaci guncel tut
  if (game) updateConn({ connected: lobby.connected, count: lobby.count });
});

socket.on('question:start', (q) => { if (game) renderStageQuestion(q); });
socket.on('question:result:host', (r) => { if (game) { hostTimer.stop(); renderStageReveal(r); } });
socket.on('leaderboard', (d) => { if (game) renderStageLeaderboard(d); });
socket.on('game:ended', (f) => { if (game) renderStageFinal(f); });

socket.on('disconnect', () => show($('connBanner')));
socket.on('connect', () => {
  hide($('connBanner'));
  if (game) {
    socket.emit('host:reclaim', { pin: game.pin, hostToken: game.hostToken }, (res) => {
      if (res && res.ok) applyHostSnapshot(res.snapshot);
      else { toast('Oyun artık açık değil.', true); leaveGame(); }
    });
  }
});

/* ------------------------------------------------------------ sesler */

let audioCtx = null;
let soundOn = true;
let lastTickSec = null;

function ac() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

document.addEventListener('click', () => { if (soundOn) ac(); }, { once: true });

function beep(freq, dur, when, gain, type) {
  const ctx = ac();
  if (!ctx || !soundOn) return;
  const t = ctx.currentTime + (when || 0);
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type || 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain || 0.12, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function tickSound(remainMs) {
  if (remainMs == null || remainMs <= 0) { lastTickSec = null; return; }
  const sec = Math.ceil(remainMs / 1000);
  if (sec <= 5 && sec !== lastTickSec) {
    lastTickSec = sec;
    beep(880, 0.09, 0, 0.09, 'square');
  }
}

function revealSound() {
  beep(523, 0.12, 0, 0.1);
  beep(784, 0.22, 0.1, 0.1);
}

function finalSound() {
  beep(523, 0.15, 0, 0.11);
  beep(659, 0.15, 0.14, 0.11);
  beep(784, 0.15, 0.28, 0.11);
  beep(1047, 0.4, 0.42, 0.12);
}

$('btnSound').addEventListener('click', () => {
  soundOn = !soundOn;
  $('btnSound').textContent = soundOn ? 'Ses: Açık' : 'Ses: Kapalı';
  if (soundOn) ac();
});

/* ------------------------------------------------------- baslangic */

(function init() {
  $('hdrUrl').textContent = location.host;
  show($('hdrUrl'));

  let savedGame = null;
  try { savedGame = JSON.parse(localStorage.getItem('cq_host_session') || 'null'); } catch (e) {}

  const enter = () => {
    if (savedGame && savedGame.pin && savedGame.hostToken) {
      socket.emit('host:reclaim', { pin: savedGame.pin, hostToken: savedGame.hostToken }, (res) => {
        if (res && res.ok) {
          game = savedGame;
          applyHostSnapshot(res.snapshot);
          showView(VIEWS, 'v-stage');
        } else {
          try { localStorage.removeItem('cq_host_session'); } catch (e) {}
          renderDash();
          showView(VIEWS, 'v-dash');
        }
      });
    } else {
      renderDash();
      showView(VIEWS, 'v-dash');
    }
  };

  const boot = () => {
    if (password) {
      tryLogin(password, (ok) => {
        if (ok) enter();
        else { password = null; sessionStorage.removeItem('cq_pw'); showView(VIEWS, 'v-login'); }
      });
    } else {
      showView(VIEWS, 'v-login');
    }
  };

  if (socket.connected) boot();
  else socket.once('connect', boot);
})();
