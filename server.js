'use strict';

/*
 * BaBaBo Quiz sunucusu
 * Kahoot tarzi canli yarisma: PIN ile katilim, soru basina ozel puan,
 * bosluk doldurma destegi, sunucu tarafinda puanlama, canli skor tablosu.
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'quiz123';

const MAX_GAMES = 60;
const MAX_PLAYERS_PER_GAME = 300;
const GAME_IDLE_TTL_MS = 4 * 60 * 60 * 1000; // 4 saat hareketsiz oyunlar silinir
const ENDED_TTL_MS = 45 * 60 * 1000; // biten oyunlar 45 dk sonra silinir

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, extensions: ['html'] }));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 512 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
});

/* ---------------------------------------------------------------- durum */

const games = new Map(); // pin -> game

function newPin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games.has(pin));
  return pin;
}

function now() { return Date.now(); }

/* ------------------------------------------------------- yardimcilar */

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f\u200b-\u200f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function toInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Bosluk doldurma cevaplarini karsilastirma icin normallestir.
// Turkce buyuk/kucuk harf donusumu icin tr yereli kullanilir (I/i sorunu).
function normalizeAnswer(s, caseSensitive) {
  let t = String(s || '').normalize('NFC');
  t = t.replace(/\s+/g, ' ').trim();
  if (!caseSensitive) t = t.toLocaleLowerCase('tr-TR');
  return t;
}

// Kucuk yazim hatasi toleransi: en fazla 1 harf fark (ekleme/silme/degisme)
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }
    else if (la > lb) { i++; }
    else { j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

function isFibCorrect(value, q) {
  const given = normalizeAnswer(value, q.caseSensitive);
  if (!given) return false;
  for (const acc of q.acceptedNorm) {
    if (given === acc) return true;
    if (q.typoTolerance && acc.length >= 4 && withinOneEdit(given, acc)) return true;
  }
  return false;
}

/* ------------------------------------------------- quiz dogrulama */

function sanitizeQuiz(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Quiz verisi okunamadi.' };
  const title = cleanText(raw.title, 80) || 'Adsiz Quiz';
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { error: 'Quizde en az bir soru olmali.' };
  }
  if (raw.questions.length > 150) return { error: 'En fazla 150 soru olabilir.' };

  const questions = [];
  for (let i = 0; i < raw.questions.length; i++) {
    const rq = raw.questions[i] || {};
    const type = rq.type === 'fib' ? 'fib' : (rq.type === 'trap' ? 'trap' : 'mc');
    const text = cleanText(rq.text, 400);
    if (!text) return { error: `${i + 1}. sorunun metni bos.` };
    const points = toInt(rq.points, 0, 1000000, 100);
    const timeLimit = toInt(rq.timeLimit, 0, 600, 20);

    const q = { type, text, points, timeLimit };

    // Risk bayragi: takimlar soru acilmadan puan riske eder (tuzakla birlesmez)
    q.risk = !!rq.risk && type !== 'trap';
    if (q.risk) {
      q.category = cleanText(rq.category, 60);
      q.riskZero = toInt(rq.riskZero, 1, 1000000, 100); // 0 puandaki takim bu deger icin oynar
    }

    if (type === 'mc' || type === 'trap') {
      const options = (Array.isArray(rq.options) ? rq.options : [])
        .map((o) => cleanText(o, 160))
        .filter((o) => o.length > 0)
        .slice(0, 6);
      if (options.length < 2) return { error: `${i + 1}. soruda en az 2 dolu sik olmali.` };
      const correct = Array.from(new Set((Array.isArray(rq.correct) ? rq.correct : [])
        .map((n) => toInt(n, 0, options.length - 1, -1))
        .filter((n) => n >= 0 && n < options.length)));
      if (correct.length === 0) return { error: `${i + 1}. soruda dogru sik isaretlenmemis.` };
      q.options = options;
      q.correct = correct;
      if (type === 'trap') {
        const traps = Array.from(new Set((Array.isArray(rq.traps) ? rq.traps : [])
          .map((n) => toInt(n, 0, options.length - 1, -1))
          .filter((n) => n >= 0 && n < options.length)));
        if (traps.length === 0) return { error: `${i + 1}. soruda tuzak sik isaretlenmemis.` };
        if (traps.some((t) => correct.includes(t))) return { error: `${i + 1}. soruda ayni sik hem dogru hem tuzak olamaz.` };
        q.traps = traps;
      }
    } else {
      const accepted = (Array.isArray(rq.accepted) ? rq.accepted : [])
        .map((a) => cleanText(a, 100))
        .filter((a) => a.length > 0)
        .slice(0, 30);
      if (accepted.length === 0) return { error: `${i + 1}. soru icin kabul edilen cevap girilmemis.` };
      q.accepted = accepted;
      q.caseSensitive = !!rq.caseSensitive;
      q.typoTolerance = !!rq.typoTolerance;
      q.acceptedNorm = Array.from(new Set(accepted.map((a) => normalizeAnswer(a, q.caseSensitive))));
    }
    questions.push(q);
  }
  return { quiz: { title, questions } };
}

/* --------------------------------------------------- oyun yasami */

function createGame(quiz) {
  const pin = newPin();
  const game = {
    pin,
    quiz,
    hostToken: crypto.randomUUID(),
    hostSocketId: null,
    players: new Map(), // token -> player
    state: 'lobby', // lobby | wager | question | reveal | leaderboard | ended
    currentIndex: -1,
    wagerIndex: -1,
    endsAt: null,
    timerHandle: null,
    lastReveal: null, // { distribution, correctDisplay, answeredCount }
    createdAt: now(),
    lastActivity: now(),
    endedAt: null,
  };
  games.set(pin, game);
  return game;
}

function touch(game) { game.lastActivity = now(); }

function destroyGame(game, reason) {
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }
  if (reason) io.to(room(game)).emit('game:cancelled', { reason });
  io.in(room(game)).socketsLeave(room(game));
  games.delete(game.pin);
}

setInterval(() => {
  const t = now();
  for (const game of games.values()) {
    const idle = t - game.lastActivity > GAME_IDLE_TTL_MS;
    const endedLongAgo = game.state === 'ended' && game.endedAt && t - game.endedAt > ENDED_TTL_MS;
    if (idle || endedLongAgo) destroyGame(game, idle ? 'Oyun uzun sure hareketsiz kaldigi icin kapatildi.' : null);
  }
}, 10 * 60 * 1000).unref();

function room(game) { return 'g:' + game.pin; }

function connectedPlayers(game) {
  let n = 0;
  for (const p of game.players.values()) if (p.connected) n++;
  return n;
}

function lobbyPayload(game) {
  const players = [];
  for (const p of game.players.values()) {
    players.push({ nickname: p.nickname, connected: p.connected, token: undefined });
  }
  players.sort((a, b) => a.nickname.localeCompare(b.nickname, 'tr'));
  return { count: game.players.size, connected: connectedPlayers(game), players: players.slice(0, 400) };
}

function hostLobbyPayload(game) {
  const players = [];
  for (const p of game.players.values()) {
    players.push({ nickname: p.nickname, connected: p.connected, token: p.token, score: p.score });
  }
  players.sort((a, b) => a.nickname.localeCompare(b.nickname, 'tr'));
  return { count: game.players.size, connected: connectedPlayers(game), players };
}

function broadcastLobby(game) {
  io.to(room(game)).emit('lobby:update', lobbyPayload(game));
  if (game.hostSocketId) io.to(game.hostSocketId).emit('lobby:update:host', hostLobbyPayload(game));
}

function publicQuestion(game) {
  const i = game.currentIndex;
  const q = game.quiz.questions[i];
  if (!q) return null;
  const pub = {
    index: i,
    total: game.quiz.questions.length,
    type: q.type,
    text: q.text,
    points: q.points,
    risk: !!q.risk,
    category: q.category || '',
    timeLimit: q.timeLimit,
    endsAt: game.endsAt,
    serverNow: now(),
  };
  if (q.type !== 'fib') pub.options = q.options;
  return pub;
}

/* ------------------------------------------------------ risk (bahis) */

function wagerYou(game, index, p) {
  const q = game.quiz.questions[index];
  const existing = p.wagers && p.wagers[index];
  return {
    index,
    total: game.quiz.questions.length,
    category: q.category || '',
    score: p.score,
    maxWager: Math.max(0, Math.floor(p.score)),
    forced: p.score < 1 ? q.riskZero : null,
    current: existing && !existing.zero ? existing.amount : null,
  };
}

function emitWagerHost(game) {
  if (!game.hostSocketId || game.state !== 'wager') return;
  let eligible = 0, decided = 0, zero = 0;
  for (const p of game.players.values()) {
    if (!p.connected) continue;
    if (p.score < 1) { zero++; continue; }
    eligible++;
    if (p.wagers && p.wagers[game.wagerIndex] !== undefined) decided++;
  }
  const q = game.quiz.questions[game.wagerIndex];
  io.to(game.hostSocketId).emit('wager:progress', {
    index: game.wagerIndex,
    total: game.quiz.questions.length,
    category: q ? (q.category || '') : '',
    decided, eligible, zero,
    playerCount: connectedPlayers(game),
  });
}

function startWager(game, index) {
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }
  game.state = 'wager';
  game.wagerIndex = index;
  game.endsAt = null;
  touch(game);
  for (const p of game.players.values()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('wager:start', wagerYou(game, index, p));
  }
  emitWagerHost(game);
  return { ok: true };
}

// Soru acilirken: risk girmeyen 1 puanla, 0 puandaki takim riskZero icin oynar
function finalizeWagers(game, index) {
  const q = game.quiz.questions[index];
  for (const p of game.players.values()) {
    p.wagers = p.wagers || {};
    if (p.wagers[index] === undefined) {
      if (p.score < 1) p.wagers[index] = { zero: true, plays: q.riskZero };
      else p.wagers[index] = { amount: 1, auto: true };
    }
  }
}

function correctDisplay(q) {
  if (q.type !== 'fib') {
    const cd = { type: 'mc', indices: q.correct, texts: q.correct.map((i) => q.options[i]) };
    if (q.type === 'trap') {
      cd.traps = q.traps;
      cd.trapTexts = q.traps.map((i) => q.options[i]);
    }
    return cd;
  }
  return { type: 'fib', answers: q.accepted };
}

function sortedPlayers(game) {
  const arr = Array.from(game.players.values());
  arr.sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  return arr;
}

// Standart yarisma siralamasi: esit puanlar ayni sirayi paylasir (1,2,2,4)
// prevScore/prevRank: son puanlama oncesi durum (skor tablosu animasyonu icin)
function leaderboard(game) {
  const arr = sortedPlayers(game);

  const beforeArr = Array.from(game.players.values())
    .map((p) => ({ token: p.token, prevScore: p.score - (p.lastGain || 0), joinedAt: p.joinedAt }));
  beforeArr.sort((a, b) => b.prevScore - a.prevScore || a.joinedAt - b.joinedAt);
  const prevRankMap = new Map();
  let ps = null, pr = 0;
  for (let i = 0; i < beforeArr.length; i++) {
    const b = beforeArr[i];
    const rank = (b.prevScore === ps) ? pr : i + 1;
    ps = b.prevScore; pr = rank;
    prevRankMap.set(b.token, { prevRank: rank, prevScore: b.prevScore });
  }

  const rows = [];
  let prevScore = null, prevRank = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const rank = (p.score === prevScore) ? prevRank : i + 1;
    prevScore = p.score; prevRank = rank;
    const before = prevRankMap.get(p.token) || { prevRank: rank, prevScore: p.score };
    rows.push({
      rank, nickname: p.nickname, score: p.score, gain: p.lastGain || 0,
      prevRank: before.prevRank, prevScore: before.prevScore,
      token: p.token, connected: p.connected,
    });
  }
  return rows;
}

function rankOf(rows, token) {
  const r = rows.find((x) => x.token === token);
  return r ? r.rank : null;
}

function stripRows(rows, n) {
  return rows.slice(0, n).map((r) => ({
    rank: r.rank, nickname: r.nickname, score: r.score, gain: r.gain,
    prevRank: r.prevRank, prevScore: r.prevScore,
  }));
}

/* ------------------------------------------------------ soru akisi */

function startQuestion(game, index) {
  const total = game.quiz.questions.length;
  if (index < 0 || index >= total) return { error: 'Soru bulunamadi.' };
  if (game.state === 'question') return { error: 'Once acik soruyu kapat.' };
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }

  const q = game.quiz.questions[index];

  // Risk sorusu once bahis asamasindan gecer; ikinci cagri soruyu acar
  if (q.risk && !(game.state === 'wager' && game.wagerIndex === index)) {
    return startWager(game, index);
  }
  if (q.risk) finalizeWagers(game, index);

  game.currentIndex = index;
  game.state = 'question';
  game.lastReveal = null;
  game.endsAt = q.timeLimit > 0 ? now() + q.timeLimit * 1000 : null;
  if (q.timeLimit > 0) {
    game.timerHandle = setTimeout(() => {
      game.timerHandle = null;
      closeQuestion(game);
    }, q.timeLimit * 1000 + 150);
  }
  touch(game);
  const pub = publicQuestion(game);
  if (q.risk) {
    // Her oyuncu kendi risk miktarini gorur
    for (const p of game.players.values()) {
      if (!p.connected || !p.socketId) continue;
      const w = p.wagers[index];
      io.to(p.socketId).emit('question:start', {
        ...pub,
        yourWager: w ? (w.zero ? { zero: true, plays: w.plays } : { amount: w.amount }) : null,
      });
    }
    if (game.hostSocketId) io.to(game.hostSocketId).emit('question:start', pub);
  } else {
    io.to(room(game)).emit('question:start', pub);
  }
  emitProgress(game);
  return { ok: true };
}

function emitProgress(game) {
  if (!game.hostSocketId) return;
  const i = game.currentIndex;
  let answered = 0;
  for (const p of game.players.values()) if (p.answers[i] !== undefined) answered++;
  io.to(game.hostSocketId).emit('progress', { answered, total: connectedPlayers(game) });
}

function closeQuestion(game) {
  if (game.state !== 'question') return { error: 'Acik soru yok.' };
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }
  const i = game.currentIndex;
  const q = game.quiz.questions[i];
  game.state = 'reveal';
  game.endsAt = null;

  // Puanlama
  let answeredCount = 0;
  const rows = [];
  for (const p of game.players.values()) {
    const a = p.answers[i];
    let correct = false;
    let trapped = false;
    let display = null;
    if (a !== undefined) {
      answeredCount++;
      if (q.type !== 'fib') {
        correct = q.correct.includes(a);
        trapped = q.type === 'trap' && q.traps.includes(a);
        display = q.options[a] !== undefined ? q.options[a] : null;
      } else {
        correct = isFibCorrect(a, q);
        display = String(a).slice(0, 100);
      }
    }
    let gain;
    if (q.risk) {
      const w = (p.wagers && p.wagers[i]) || (p.score < 1 ? { zero: true, plays: q.riskZero } : { amount: 1 });
      if (w.zero) gain = correct ? w.plays : 0; // 0 puandaki takim: kazanir ama kaybetmez
      else gain = correct ? w.amount : -w.amount; // dogruda +risk, yanlista -risk
    } else if (q.type === 'trap') {
      gain = correct ? q.points : (trapped ? -q.points : 0); // tuzaga dusen puan kaybeder
    } else {
      gain = correct ? q.points : 0;
    }
    p.score += gain;
    p.lastGain = gain;
    p.lastResult = { index: i, answered: a !== undefined, correct, trapped, gain, display };
  }

  // Dagilim (host ekrani icin)
  let distribution;
  if (q.type !== 'fib') {
    const counts = q.options.map(() => 0);
    for (const p of game.players.values()) {
      const a = p.answers[i];
      if (a !== undefined && counts[a] !== undefined) counts[a]++;
    }
    distribution = { type: 'mc', counts, noAnswer: game.players.size - answeredCount };
  } else {
    const buckets = new Map();
    let correctCount = 0;
    for (const p of game.players.values()) {
      const a = p.answers[i];
      if (a === undefined) continue;
      const key = normalizeAnswer(a, q.caseSensitive) || '(bos)';
      const b = buckets.get(key) || { text: String(a).replace(/\s+/g, ' ').trim().slice(0, 60) || '(bos)', count: 0, correct: false };
      b.count++;
      b.correct = b.correct || isFibCorrect(a, q);
      buckets.set(key, b);
    }
    for (const p of game.players.values()) if (p.lastResult && p.lastResult.index === i && p.lastResult.correct) correctCount++;
    const top = Array.from(buckets.values()).sort((a, b) => b.count - a.count).slice(0, 8);
    distribution = { type: 'fib', top, correctCount, noAnswer: game.players.size - answeredCount };
  }

  const cd = correctDisplay(q);
  game.lastReveal = { distribution, correctDisplay: cd, answeredCount, index: i, points: q.points };
  touch(game);

  // Oyunculara kisisel sonuc
  const lb = leaderboard(game);
  for (const p of game.players.values()) {
    if (!p.connected || !p.socketId) continue;
    const r = p.lastResult && p.lastResult.index === i ? p.lastResult : { answered: false, correct: false, gain: 0, display: null };
    io.to(p.socketId).emit('question:result', {
      index: i,
      answered: r.answered,
      correct: r.correct,
      trapped: !!r.trapped,
      gain: r.gain,
      score: p.score,
      rank: rankOf(lb, p.token),
      playerCount: game.players.size,
      correctDisplay: cd,
      yourAnswer: r.display,
    });
  }
  // Hosta ozet
  if (game.hostSocketId) {
    io.to(game.hostSocketId).emit('question:result:host', {
      index: i,
      distribution,
      correctDisplay: cd,
      answeredCount,
      playerCount: game.players.size,
      top: stripRows(lb, 5),
    });
  }
  return { ok: true };
}

function showLeaderboard(game) {
  if (game.state !== 'reveal' && game.state !== 'leaderboard') return { error: 'Sıralama bu asamada gosterilemez.' };
  game.state = 'leaderboard';
  touch(game);
  const lb = leaderboard(game);
  const top = stripRows(lb, 10);
  const payloadBase = {
    top,
    questionIndex: game.currentIndex,
    total: game.quiz.questions.length,
    isLast: game.currentIndex >= game.quiz.questions.length - 1,
  };
  for (const p of game.players.values()) {
    if (!p.connected || !p.socketId) continue;
    const mine = lb.find((r) => r.token === p.token);
    io.to(p.socketId).emit('leaderboard', {
      ...payloadBase,
      you: mine
        ? { nickname: p.nickname, rank: mine.rank, score: mine.score, gain: mine.gain, prevRank: mine.prevRank, prevScore: mine.prevScore }
        : { nickname: p.nickname, rank: null, score: p.score, gain: p.lastGain || 0 },
    });
  }
  if (game.hostSocketId) io.to(game.hostSocketId).emit('leaderboard', payloadBase);
  return { ok: true };
}

function endGame(game) {
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }
  game.state = 'ended';
  game.endedAt = now();
  touch(game);
  const lb = leaderboard(game);
  const podium = stripRows(lb, 3);
  const top = stripRows(lb, 10);
  for (const p of game.players.values()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('game:ended', {
      podium, top,
      you: { rank: rankOf(lb, p.token), score: p.score },
      playerCount: game.players.size,
      title: game.quiz.title,
    });
  }
  if (game.hostSocketId) {
    io.to(game.hostSocketId).emit('game:ended', {
      podium, top,
      full: lb.map((r) => ({ rank: r.rank, nickname: r.nickname, score: r.score })),
      playerCount: game.players.size,
      title: game.quiz.title,
    });
  }
  return { ok: true };
}

/* ------------------------------------------------------- anlik goruntu */

function playerSnapshot(game, p) {
  const snap = {
    state: game.state,
    title: game.quiz.title,
    total: game.quiz.questions.length,
    currentIndex: game.currentIndex,
    you: { nickname: p.nickname, score: p.score },
    lobby: lobbyPayload(game),
  };
  if (game.state === 'wager') {
    snap.wager = wagerYou(game, game.wagerIndex, p);
  }
  if (game.state === 'question') {
    snap.question = publicQuestion(game);
    const q = game.quiz.questions[game.currentIndex];
    if (q && q.risk) {
      const w = p.wagers && p.wagers[game.currentIndex];
      snap.question.yourWager = w ? (w.zero ? { zero: true, plays: w.plays } : { amount: w.amount }) : null;
    }
    snap.answered = p.answers[game.currentIndex] !== undefined;
  }
  if (game.state === 'reveal' && game.lastReveal) {
    const r = p.lastResult && p.lastResult.index === game.currentIndex ? p.lastResult : null;
    const lb = leaderboard(game);
    snap.result = {
      index: game.currentIndex,
      answered: r ? r.answered : false,
      correct: r ? r.correct : false,
      trapped: r ? !!r.trapped : false,
      gain: r ? r.gain : 0,
      score: p.score,
      rank: rankOf(lb, p.token),
      playerCount: game.players.size,
      correctDisplay: game.lastReveal.correctDisplay,
      yourAnswer: r ? r.display : null,
    };
  }
  if (game.state === 'leaderboard') {
    const lb = leaderboard(game);
    const mine = lb.find((r) => r.token === p.token);
    snap.leaderboardData = {
      top: stripRows(lb, 10),
      you: mine
        ? { nickname: p.nickname, rank: mine.rank, score: mine.score, gain: mine.gain, prevRank: mine.prevRank, prevScore: mine.prevScore }
        : { nickname: p.nickname, rank: null, score: p.score, gain: p.lastGain || 0 },
      questionIndex: game.currentIndex,
      total: game.quiz.questions.length,
      isLast: game.currentIndex >= game.quiz.questions.length - 1,
    };
  }
  if (game.state === 'ended') {
    const lb = leaderboard(game);
    snap.final = {
      podium: stripRows(lb, 3),
      top: stripRows(lb, 10),
      you: { rank: rankOf(lb, p.token), score: p.score },
      playerCount: game.players.size,
      title: game.quiz.title,
    };
  }
  return snap;
}

function hostSnapshot(game) {
  const snap = {
    state: game.state,
    pin: game.pin,
    quiz: {
      title: game.quiz.title,
      questions: game.quiz.questions.map((q) => ({
        type: q.type, text: q.text, points: q.points, timeLimit: q.timeLimit,
        options: q.options, correct: q.correct, accepted: q.accepted,
        caseSensitive: q.caseSensitive, typoTolerance: q.typoTolerance,
        risk: !!q.risk, category: q.category || '', riskZero: q.riskZero,
        traps: q.traps,
      })),
    },
    currentIndex: game.currentIndex,
    lobby: hostLobbyPayload(game),
  };
  if (game.state === 'wager') {
    let eligible = 0, decided = 0, zero = 0;
    for (const p of game.players.values()) {
      if (!p.connected) continue;
      if (p.score < 1) { zero++; continue; }
      eligible++;
      if (p.wagers && p.wagers[game.wagerIndex] !== undefined) decided++;
    }
    const wq = game.quiz.questions[game.wagerIndex];
    snap.wagerData = {
      index: game.wagerIndex,
      total: game.quiz.questions.length,
      category: wq ? (wq.category || '') : '',
      decided, eligible, zero,
      playerCount: connectedPlayers(game),
    };
  }
  if (game.state === 'question') snap.question = publicQuestion(game);
  if (game.state === 'reveal' && game.lastReveal) {
    snap.reveal = { ...game.lastReveal, top: stripRows(leaderboard(game), 5), playerCount: game.players.size };
  }
  if (game.state === 'leaderboard') {
    const lb = leaderboard(game);
    snap.leaderboardData = {
      top: stripRows(lb, 10),
      questionIndex: game.currentIndex,
      total: game.quiz.questions.length,
      isLast: game.currentIndex >= game.quiz.questions.length - 1,
    };
  }
  if (game.state === 'ended') {
    const lb = leaderboard(game);
    snap.final = {
      podium: stripRows(lb, 3), top: stripRows(lb, 10),
      full: lb.map((r) => ({ rank: r.rank, nickname: r.nickname, score: r.score })),
      playerCount: game.players.size, title: game.quiz.title,
    };
  }
  return snap;
}

/* --------------------------------------------------------- soketler */

function requireHost(payload) {
  const game = games.get(String(payload && payload.pin || ''));
  if (!game) return { error: 'Oyun bulunamadi.' };
  if (!payload.hostToken || payload.hostToken !== game.hostToken) return { error: 'Yetki yok.' };
  return { game };
}

io.on('connection', (socket) => {
  socket.data.pwAttempts = 0;

  const safe = (fn) => (payload, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    try { fn(payload || {}, cb); }
    catch (err) {
      console.error('socket handler error:', err);
      cb({ error: 'Sunucu hatasi olustu.' });
    }
  };

  /* ---- host ---- */

  socket.on('host:login', safe((payload, cb) => {
    socket.data.pwAttempts++;
    if (socket.data.pwAttempts > 15) { cb({ error: 'Cok fazla deneme. Sayfayi yenile.' }); return; }
    if (String(payload.password || '') !== ADMIN_PASSWORD) { cb({ error: 'Sifre yanlis.' }); return; }
    cb({ ok: true });
  }));

  socket.on('host:create', safe((payload, cb) => {
    socket.data.pwAttempts++;
    if (socket.data.pwAttempts > 15) { cb({ error: 'Cok fazla deneme. Sayfayi yenile.' }); return; }
    if (String(payload.password || '') !== ADMIN_PASSWORD) { cb({ error: 'Sifre yanlis.' }); return; }
    if (games.size >= MAX_GAMES) { cb({ error: 'Sunucuda cok fazla acik oyun var. Biraz sonra dene.' }); return; }
    const { quiz, error } = sanitizeQuiz(payload.quiz);
    if (error) { cb({ error }); return; }
    const game = createGame(quiz);
    game.hostSocketId = socket.id;
    socket.join(room(game));
    socket.data.hostPin = game.pin;
    cb({ ok: true, pin: game.pin, hostToken: game.hostToken, snapshot: hostSnapshot(game) });
  }));

  socket.on('host:reclaim', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    game.hostSocketId = socket.id;
    socket.join(room(game));
    socket.data.hostPin = game.pin;
    touch(game);
    cb({ ok: true, snapshot: hostSnapshot(game) });
    emitProgress(game);
  }));

  socket.on('host:start_question', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    cb(startQuestion(game, toInt(payload.index, 0, 100000, 0)));
  }));

  socket.on('host:close_question', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    cb(closeQuestion(game));
  }));

  socket.on('host:show_leaderboard', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    cb(showLeaderboard(game));
  }));

  socket.on('host:end_game', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    cb(endGame(game));
  }));

  socket.on('host:cancel', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    destroyGame(game, 'Sunucu oyunu kapatti.');
    cb({ ok: true });
  }));

  socket.on('host:kick', safe((payload, cb) => {
    const { game, error } = requireHost(payload);
    if (error) { cb({ error }); return; }
    const p = game.players.get(String(payload.playerToken || ''));
    if (!p) { cb({ error: 'Oyuncu bulunamadi.' }); return; }
    game.players.delete(p.token);
    if (p.socketId) {
      io.to(p.socketId).emit('player:kicked');
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.leave(room(game));
    }
    broadcastLobby(game);
    cb({ ok: true });
  }));

  /* ---- oyuncu ---- */

  socket.on('game:exists', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game || game.state === 'ended') { cb({ ok: false }); return; }
    cb({ ok: true, title: game.quiz.title });
  }));

  socket.on('player:join', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game) { cb({ error: 'Bu PIN ile acik bir oyun yok.' }); return; }
    // Not: biten oyuna YENI oyuncu alinmaz ama mevcut oyuncu final ekranini
    // gormek icin geri donebilir (asagida kontrol ediliyor).

    const token = String(payload.token || '');
    let player = token ? game.players.get(token) : null;

    if (!player) {
      const nickname = cleanText(payload.nickname, 20);
      if (!nickname) { cb({ error: 'Bir takım adı yaz.' }); return; }
      if (game.players.size >= MAX_PLAYERS_PER_GAME) { cb({ error: 'Oyun dolu.' }); return; }
      const nnorm = nickname.toLocaleLowerCase('tr-TR');
      let sameName = null;
      for (const p of game.players.values()) {
        if (p.nickname.toLocaleLowerCase('tr-TR') === nnorm) { sameName = p; break; }
      }
      if (sameName) {
        if (sameName.connected) {
          cb({ error: 'Bu takım adı şu an oyunda, başka bir tane dene.' });
          return;
        }
        // Baglantisi kopmus takim ayni adla geri donuyor (telefon/tarayici
        // degisse bile): skoru ve cevaplari korunarak devralinir.
        player = sameName;
      } else {
        if (game.state === 'ended') { cb({ error: 'Bu oyun sona erdi.' }); return; }
        player = {
          token: crypto.randomUUID(),
          nickname,
          score: 0,
          lastGain: 0,
          lastResult: null,
          answers: {},
          wagers: {},
          connected: true,
          socketId: socket.id,
          joinedAt: now(),
        };
        game.players.set(player.token, player);
      }
      player.connected = true;
      player.socketId = socket.id;
    } else {
      // yeniden baglanma: skor ve cevaplar korunur
      if (player.socketId && player.socketId !== socket.id) {
        const old = io.sockets.sockets.get(player.socketId);
        if (old) { old.data.playerRef = null; old.leave(room(game)); }
      }
      player.connected = true;
      player.socketId = socket.id;
    }

    socket.join(room(game));
    socket.data.playerRef = { pin: game.pin, token: player.token };
    touch(game);
    broadcastLobby(game);
    emitProgress(game);
    cb({ ok: true, token: player.token, nickname: player.nickname, snapshot: playerSnapshot(game, player) });
  }));

  socket.on('player:wager', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game) { cb({ error: 'Oyun bulunamadi.' }); return; }
    const player = game.players.get(String(payload.token || ''));
    if (!player) { cb({ error: 'Once oyuna katil.' }); return; }
    if (game.state !== 'wager' || toInt(payload.index, -1, 100000, -1) !== game.wagerIndex) {
      cb({ error: 'Risk asamasi su an acik degil.' });
      return;
    }
    if (player.score < 1) { cb({ error: 'Puanin olmadigi icin bu turda otomatik oynuyorsun.' }); return; }
    const maxW = Math.floor(player.score);
    const amt = toInt(payload.amount, -1000000000, 1000000000, -1);
    if (amt < 1) { cb({ error: 'En az 1 puan riske etmelisin.' }); return; }
    if (amt > maxW) { cb({ error: 'En fazla ' + maxW + ' puan riske edebilirsin.' }); return; }
    player.wagers = player.wagers || {};
    player.wagers[game.wagerIndex] = { amount: amt };
    touch(game);
    cb({ ok: true, amount: amt });
    emitWagerHost(game);
  }));

  socket.on('player:leave', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game) { cb({ ok: true }); return; }
    const player = game.players.get(String(payload.token || ''));
    if (player && player.socketId === socket.id) {
      player.connected = false;
      player.socketId = null;
      socket.leave(room(game));
      socket.data.playerRef = null;
      broadcastLobby(game);
    }
    cb({ ok: true });
  }));

  socket.on('player:sync', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game) { cb({ error: 'Oyun bulunamadi.' }); return; }
    const player = game.players.get(String(payload.token || ''));
    if (!player) { cb({ error: 'Oyuncu bulunamadi.' }); return; }
    cb({ ok: true, snapshot: playerSnapshot(game, player) });
  }));

  socket.on('player:answer', safe((payload, cb) => {
    const game = games.get(String(payload.pin || ''));
    if (!game) { cb({ error: 'Oyun bulunamadi.' }); return; }
    const player = game.players.get(String(payload.token || ''));
    if (!player) { cb({ error: 'Once oyuna katil.' }); return; }
    if (game.state !== 'question') { cb({ error: 'Su anda acik soru yok.' }); return; }
    const i = game.currentIndex;
    if (toInt(payload.index, -1, 100000, -1) !== i) { cb({ error: 'Bu soru kapandi.' }); return; }
    if (game.endsAt && now() > game.endsAt + 400) { cb({ error: 'Sure doldu.' }); return; }
    if (player.answers[i] !== undefined) { cb({ error: 'Cevabin zaten alindi.' }); return; }

    const q = game.quiz.questions[i];
    let value;
    if (q.type !== 'fib') {
      const n = toInt(payload.value, 0, q.options.length - 1, -1);
      if (n < 0) { cb({ error: 'Gecersiz sik.' }); return; }
      value = n;
    } else {
      value = cleanText(String(payload.value == null ? '' : payload.value), 100);
      if (!value) { cb({ error: 'Bos cevap gonderilemez.' }); return; }
    }
    player.answers[i] = value;
    touch(game);
    cb({ ok: true });
    emitProgress(game);

    // Herkes cevapladiysa soruyu otomatik kapat (host beklemesin)
    let all = true;
    for (const p of game.players.values()) {
      if (p.connected && p.answers[i] === undefined) { all = false; break; }
    }
    if (all && connectedPlayers(game) > 0) closeQuestion(game);
  }));

  /* ---- kopma ---- */

  socket.on('disconnect', () => {
    const ref = socket.data.playerRef;
    if (ref) {
      const game = games.get(ref.pin);
      if (game) {
        const p = game.players.get(ref.token);
        if (p && p.socketId === socket.id) {
          p.connected = false;
          p.socketId = null;
          broadcastLobby(game);
        }
      }
    }
    const hostPin = socket.data.hostPin;
    if (hostPin) {
      const game = games.get(hostPin);
      if (game && game.hostSocketId === socket.id) game.hostSocketId = null;
      // Oyun devam eder; host sayfayi yenileyip geri gelebilir.
    }
  });
});

server.listen(PORT, () => {
  console.log(`BaBaBo Quiz calisiyor: http://localhost:${PORT}`);
  console.log(`Host paneli:        http://localhost:${PORT}/host`);
  console.log(`Admin sifresi:      ${ADMIN_PASSWORD === 'quiz123' ? 'quiz123 (degistirmek icin ADMIN_PASSWORD ortam degiskenini ayarla)' : '(ADMIN_PASSWORD ortam degiskeninden alindi)'}`);
});
