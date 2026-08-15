/* 85 oyunculu tam oyun simulasyonu: puanlama, bosluk doldurma, yeniden baglanma */
'use strict';

const { io } = require('socket.io-client');

const URL = process.env.SIM_URL || 'http://localhost:3100';
const PASSWORD = process.env.ADMIN_PASSWORD || 'quiz123';
const N = 85;

let failures = 0;
let checks = 0;

function assert(cond, label, extra) {
  checks++;
  if (cond) {
    console.log('  [OK]   ' + label);
  } else {
    failures++;
    console.log('  [FAIL] ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function emit(s, ev, payload) {
  return new Promise((resolve) => s.emit(ev, payload, resolve));
}

function once(s, ev, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: ' + ev)), timeoutMs || 15000);
    s.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUIZ = {
  title: 'Sim Testi',
  questions: [
    { type: 'mc', text: 'Soru 1: dogru sik C', points: 100, timeLimit: 6,
      options: ['A', 'B', 'C', 'D'], correct: [2] },
    { type: 'fib', text: 'Soru 2: Turkiyenin en kalabalik sehri?', points: 150, timeLimit: 8,
      accepted: ['İstanbul'], caseSensitive: false, typoTolerance: true },
    { type: 'mc', text: 'Soru 3: dogru sik A (manuel kapanis)', points: 250, timeLimit: 0,
      options: ['Evet', 'Hayir'], correct: [0] },
    { type: 'mc', text: 'Soru 4: RISK sorusu, dogru sik B', points: 999, timeLimit: 0,
      options: ['A', 'B'], correct: [1], risk: true, category: 'Tarih', riskZero: 70 },
    { type: 'trap', text: 'Soru 5: TUZAK, dogru A, tuzak C', points: 200, timeLimit: 0,
      options: ['DogruSik', 'NotrSik', 'TuzakSik'], correct: [0], traps: [2] },
  ],
};

(async function main() {
  console.log('Sunucu:', URL);

  /* ---- host oyunu kurar ---- */
  const host = await connect();

  const badPw = await emit(host, 'host:create', { password: 'yanlis', quiz: QUIZ });
  assert(badPw.error, 'yanlis sifre reddedildi');

  const created = await emit(host, 'host:create', { password: PASSWORD, quiz: QUIZ });
  assert(created.ok, 'oyun kuruldu', created);
  const PIN = created.pin;
  const HTOKEN = created.hostToken;
  console.log('  PIN:', PIN);

  /* ---- oyuncular katilir ---- */
  const t0 = Date.now();
  const players = [];
  for (let i = 1; i <= N; i++) players.push({ i, name: 'Oyuncu' + i, socket: null, token: null, results: [], final: null });

  await Promise.all(players.map(async (p) => {
    p.socket = await connect();
    const res = await emit(p.socket, 'player:join', { pin: PIN, nickname: p.name });
    if (!res.ok) throw new Error('katilamadi: ' + p.name + ' ' + res.error);
    p.token = res.token;
    p.socket.on('question:result', (r) => p.results.push(r));
    p.socket.on('game:ended', (f) => { p.final = f; });
  }));
  console.log('  ' + N + ' oyuncu ' + (Date.now() - t0) + ' ms icinde katildi');

  const wrongPin = await connect();
  const wp = await emit(wrongPin, 'player:join', { pin: '000001', nickname: 'X' });
  assert(!!wp.error, 'yanlis PIN reddedildi');
  wrongPin.close();

  const dupSock = await connect();
  const dup = await emit(dupSock, 'player:join', { pin: PIN, nickname: 'oyuncu5' });
  assert(!!dup.error, 'ayni takma ad (buyuk/kucuk farkiyla) reddedildi');
  dupSock.close();

  /* ---- Soru 1: coktan secmeli, sure ile kapanir ---- */
  console.log('\nSoru 1 (coktan secmeli, 6 sn)');
  const q1startAll = Promise.all(players.map((p) => once(p.socket, 'question:start')));
  const q1res = await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 0 });
  assert(q1res.ok, 'soru 1 baslatildi', q1res);
  await q1startAll;

  const hostResult1 = once(host, 'question:result:host', 12000);
  await Promise.all(players.map(async (p) => {
    await sleep(100 + Math.random() * 2000);
    if (p.i <= 60) await emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 0, value: 2 });
    else if (p.i <= 80) await emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 0, value: 0 });
    // 81..85 cevapsiz
  }));

  const r1 = await hostResult1;
  assert(r1.distribution.counts[2] === 60, 'dagilim: dogru sik 60 kisi', r1.distribution.counts);
  assert(r1.distribution.counts[0] === 20, 'dagilim: yanlis sik 20 kisi', r1.distribution.counts);
  assert(r1.distribution.noAnswer === 5, 'dagilim: 5 cevapsiz', r1.distribution.noAnswer);
  assert(r1.answeredCount === 80, 'cevaplayan sayisi 80', r1.answeredCount);

  await sleep(300);
  const p1r = players[0].results[0];
  assert(p1r && p1r.correct === true && p1r.gain === 100 && p1r.score === 100, 'Oyuncu1 dogru +100', p1r);
  const p61r = players[60].results[0];
  assert(p61r && p61r.correct === false && p61r.gain === 0, 'Oyuncu61 yanlis +0', p61r);
  assert(p1r.rank === 1, 'Oyuncu1 sira 1 (beraberlik)', p1r.rank);

  const late = await emit(players[0].socket, 'player:answer', { pin: PIN, token: players[0].token, index: 0, value: 2 });
  assert(!!late.error, 'kapali soruya cevap reddedildi');

  /* ---- yeniden baglanma: Oyuncu3 ---- */
  console.log('\nYeniden baglanma testi');
  const p3 = players[2];
  p3.socket.close();
  await sleep(400);
  p3.socket = await connect();
  p3.socket.on('question:result', (r) => p3.results.push(r));
  p3.socket.on('game:ended', (f) => { p3.final = f; });
  const rejoin = await emit(p3.socket, 'player:join', { pin: PIN, nickname: p3.name, token: p3.token });
  assert(rejoin.ok && rejoin.snapshot.you.score === 100, 'Oyuncu3 skoru koruyarak geri dondu', rejoin.snapshot && rejoin.snapshot.you);

  // Token'siz kurtarma: farkli cihaz/tarayici, ayni takim adi
  const p5 = players[4];
  p5.socket.close();
  await sleep(400);
  p5.socket = await connect();
  p5.socket.on('question:result', (r) => p5.results.push(r));
  p5.socket.on('game:ended', (f) => { p5.final = f; });
  const reclaim = await emit(p5.socket, 'player:join', { pin: PIN, nickname: 'OYUNCU5' });
  assert(reclaim.ok && reclaim.snapshot.you.score === 100, 'Oyuncu5 token olmadan ayni adla skoru devraldi', reclaim.error || (reclaim.snapshot && reclaim.snapshot.you));
  p5.token = reclaim.token;
  const stillTaken = await connect();
  const st = await emit(stillTaken, 'player:join', { pin: PIN, nickname: 'Oyuncu5' });
  assert(!!st.error, 'bagli takimin adi hala korunuyor', st);
  stillTaken.close();

  /* ---- skor tablosu ---- */
  const lbP = once(players[0].socket, 'leaderboard');
  const lbH = once(host, 'leaderboard');
  await emit(host, 'host:show_leaderboard', { pin: PIN, hostToken: HTOKEN });
  const lb1 = await lbP;
  const lbh1 = await lbH;
  assert(lb1.you && lb1.you.rank === 1 && lb1.you.score === 100, 'oyuncu skor tablosunda kendini goruyor', lb1.you);
  assert(lbh1.top.length === 10 && lbh1.top.every((r) => r.score === 100), 'host top10 tutarli', lbh1.top && lbh1.top[0]);
  assert(lb1.you.prevScore === 0 && lb1.you.prevRank === 1 && lb1.you.gain === 100, 'animasyon verisi: oyuncunun onceki skoru/sirasi geldi', lb1.you);
  assert(lbh1.top.every((r) => r.prevScore === 0 && r.prevRank === 1 && r.score === r.prevScore + r.gain), 'animasyon verisi: top10 once/sonra tutarli', lbh1.top[0]);

  /* ---- Soru 2: bosluk doldurma ---- */
  console.log('\nSoru 2 (bosluk doldurma, 8 sn)');
  await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 1 });
  const hostResult2 = once(host, 'question:result:host', 14000);

  await Promise.all(players.map(async (p) => {
    await sleep(100 + Math.random() * 2500);
    const send = (v) => emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 1, value: v });
    if (p.i <= 20) await send('istanbul');
    else if (p.i <= 30) await send('İSTANBUL');
    else if (p.i <= 40) await send('istanbull');
    else if (p.i <= 60) await send('ankara');
    else if (p.i <= 70) await send('  İstanbul  ');
    // 71..85 cevapsiz
  }));

  const r2 = await hostResult2;
  const buckets = Object.fromEntries(r2.distribution.top.map((b) => [b.text.toLocaleLowerCase('tr-TR'), b]));
  assert(r2.distribution.correctCount === 50, 'bosluk doldurma: 50 dogru (buyuk/kucuk harf + bosluk + 1 harf hata toleransi)', r2.distribution.correctCount);
  assert((buckets['istanbul'] && buckets['istanbul'].count === 40 && buckets['istanbul'].correct), 'istanbul kovasi 40 ve dogru isaretli', buckets['istanbul']);
  assert((buckets['istanbull'] && buckets['istanbull'].count === 10 && buckets['istanbull'].correct), 'istanbull (yazim hatasi) 10 ve dogru isaretli', buckets['istanbull']);
  assert((buckets['ankara'] && buckets['ankara'].count === 20 && !buckets['ankara'].correct), 'ankara kovasi 20 ve yanlis', buckets['ankara']);
  assert(r2.distribution.noAnswer === 15, '15 cevapsiz', r2.distribution.noAnswer);

  await sleep(300);
  const p25 = players[24].results.find((r) => r.index === 1);
  assert(p25 && p25.correct && p25.score === 250, 'Oyuncu25 (İSTANBUL) dogru, toplam 250', p25);
  const p35 = players[34].results.find((r) => r.index === 1);
  assert(p35 && p35.correct, 'Oyuncu35 (istanbull) tolerans ile dogru', p35);
  const p45 = players[44].results.find((r) => r.index === 1);
  assert(p45 && !p45.correct && p45.score === 100, 'Oyuncu45 (ankara) yanlis, toplam 100', p45);

  /* ---- Soru 3: suresiz, manuel kapanis ---- */
  console.log('\nSoru 3 (suresiz, manuel kapanis)');
  await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 2 });
  await sleep(200);
  await Promise.all(players.map(async (p) => {
    const send = (v) => emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 2, value: v });
    if (p.i <= 40) await send(0);
    else if (p.i <= 50) await send(1);
  }));
  await sleep(300);
  const hostResult3 = once(host, 'question:result:host', 8000);
  const closeRes = await emit(host, 'host:close_question', { pin: PIN, hostToken: HTOKEN });
  assert(closeRes.ok, 'soru manuel kapatildi', closeRes);
  const r3 = await hostResult3;
  assert(r3.distribution.counts[0] === 40 && r3.distribution.counts[1] === 10, 'soru 3 dagilimi 40/10', r3.distribution.counts);

  /* ---- Soru 4: RISK ---- */
  console.log('\nSoru 4 (RISK: dogru +risk, yanlis -risk, girmeyene otomatik 1, 0 puanliya riskZero)');
  // Skorlar su an: 1..40=500, 41..60=100, 61..70=150, 71..85=0

  const wagerStartAll = Promise.all(players.map((p) => once(p.socket, 'wager:start')));
  const w4 = await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 3 });
  assert(w4.ok, 'risk (bahis) asamasi baslatildi', w4);
  const wagerInfos = await wagerStartAll;

  assert(wagerInfos[0].score === 500 && wagerInfos[0].maxWager === 500 && wagerInfos[0].forced === null && wagerInfos[0].category === 'Tarih',
    'Oyuncu1 risk ekrani: puan 500, ust sinir 500, kategori geldi', wagerInfos[0]);
  assert(wagerInfos[40].maxWager === 100, 'Oyuncu41 risk ust siniri 100', wagerInfos[40]);
  assert(wagerInfos[70].forced === 70 && wagerInfos[70].score === 0, 'Oyuncu71 (0 puan) otomatik 70 icin oynuyor', wagerInfos[70]);

  const wg = (p, amount) => emit(p.socket, 'player:wager', { pin: PIN, token: p.token, index: 3, amount });
  const e0 = await wg(players[0], 0);
  assert(!!e0.error, '0 riske etmek reddedildi', e0);
  const e501 = await wg(players[0], 501);
  assert(!!e501.error, 'puandan fazla risk reddedildi', e501);
  const e150 = await wg(players[40], 150);
  assert(!!e150.error, 'Oyuncu41 icin 150 risk reddedildi (puani 100)', e150);
  const eZero = await wg(players[70], 10);
  assert(!!eZero.error, '0 puanli takimin risk girmesi reddedildi (otomatik oynuyor)', eZero);

  const first50 = await wg(players[2], 50);
  const then200 = await wg(players[2], 200);
  assert(first50.ok && then200.ok && then200.amount === 200, 'risk soru acilana kadar degistirilebiliyor (50 -> 200)', then200);

  // Kohortlar: 1..20 -> 200 riske eder; 21..40 -> hepsini (500); 41..60 -> 100
  await Promise.all(players.map(async (p) => {
    if (p.i === 3) return; // zaten 200 girdi
    if (p.i <= 20) await wg(p, 200);
    else if (p.i <= 40) await wg(p, 500);
    else if (p.i <= 60) await wg(p, 100);
    // 61..70 hic risk girmiyor (otomatik 1), 71..85 zaten otomatik (0 puan)
  }));

  const q4StartAll = Promise.all(players.map((p) => once(p.socket, 'question:start')));
  const open4 = await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 3 });
  assert(open4.ok, 'risk sorusu acildi', open4);
  const q4s = await q4StartAll;
  assert(q4s[0].risk === true && q4s[0].yourWager && q4s[0].yourWager.amount === 200, 'Oyuncu1 soruda riskini goruyor (200)', q4s[0].yourWager);
  assert(q4s[60].yourWager && q4s[60].yourWager.amount === 1, 'risk girmeyen Oyuncu61 otomatik 1 ile oynuyor', q4s[60].yourWager);
  assert(q4s[70].yourWager && q4s[70].yourWager.zero === true && q4s[70].yourWager.plays === 70, 'Oyuncu71 zero modunda 70 icin oynuyor', q4s[70].yourWager);

  await Promise.all(players.map(async (p) => {
    const send = (v) => emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 3, value: v });
    if (p.i <= 20) await send(1);       // dogru: +200
    else if (p.i <= 40) await send(0);  // yanlis: -500
    else if (p.i <= 60) { /* cevap yok: -100 */ }
    else if (p.i <= 65) await send(1);  // dogru: +1
    else if (p.i <= 70) await send(0);  // yanlis: -1
    else if (p.i <= 75) await send(1);  // dogru (zero): +70
    // 76..85 cevap yok (zero): 0
  }));
  await sleep(400);
  const hostResult4 = once(host, 'question:result:host', 8000);
  await emit(host, 'host:close_question', { pin: PIN, hostToken: HTOKEN });
  const r4 = await hostResult4;
  assert(r4.distribution.counts[1] === 30 && r4.distribution.counts[0] === 25 && r4.distribution.noAnswer === 30,
    'risk sorusu dagilimi 30 dogru sik / 25 yanlis sik / 30 cevapsiz', r4.distribution);

  await sleep(300);
  const p1r4 = players[0].results.find((r) => r.index === 3);
  assert(p1r4 && p1r4.gain === 200 && p1r4.score === 700, 'Oyuncu1: +200 ile 700', p1r4);
  const p21r4 = players[20].results.find((r) => r.index === 3);
  assert(p21r4 && p21r4.gain === -500 && p21r4.score === 0, 'Oyuncu21: hepsini riske etti, -500 ile 0', p21r4);
  const p41r4 = players[40].results.find((r) => r.index === 3);
  assert(p41r4 && p41r4.answered === false && p41r4.gain === -100 && p41r4.score === 0, 'Oyuncu41: cevap vermedi, riski gitti (-100)', p41r4);
  const p66r4 = players[65].results.find((r) => r.index === 3);
  assert(p66r4 && p66r4.gain === -1 && p66r4.score === 149, 'Oyuncu66: otomatik 1 risk, yanlis, 149', p66r4);
  const p71r4 = players[70].results.find((r) => r.index === 3);
  assert(p71r4 && p71r4.gain === 70 && p71r4.score === 70, 'Oyuncu71: zero modunda dogru, +70', p71r4);
  const p76r4 = players[75].results.find((r) => r.index === 3);
  assert(p76r4 && p76r4.gain === 0 && p76r4.score === 0, 'Oyuncu76: zero modunda cevapsiz, kayip yok', p76r4);

  /* ---- Soru 5: TUZAK ---- */
  console.log('\nSoru 5 (TUZAK: dogru +200, tuzak -200, notr yanlis 0)');
  // Skorlar su an: 1..20=700, 21..60=0, 61..65=151, 66..70=149, 71..75=70, 76..85=0

  const q5start = once(players[0].socket, 'question:start');
  await emit(host, 'host:start_question', { pin: PIN, hostToken: HTOKEN, index: 4 });
  const q5 = await q5start;
  assert(q5.type === 'trap' && Array.isArray(q5.options) && q5.options.length === 3, 'tuzak sorusu secenekleriyle acildi', q5.type);

  await Promise.all(players.map(async (p) => {
    const send = (v) => emit(p.socket, 'player:answer', { pin: PIN, token: p.token, index: 4, value: v });
    if (p.i <= 10) await send(0);        // dogru: +200
    else if (p.i <= 30) await send(2);   // tuzak: -200 (21..30 eksiye duser)
    else if (p.i <= 40) await send(1);   // notr yanlis: 0
    // 41..85 cevap yok: 0
  }));
  await sleep(400);
  const hostResult5 = once(host, 'question:result:host', 8000);
  await emit(host, 'host:close_question', { pin: PIN, hostToken: HTOKEN });
  const r5 = await hostResult5;
  assert(r5.distribution.counts[0] === 10 && r5.distribution.counts[2] === 20 && r5.distribution.counts[1] === 10 && r5.distribution.noAnswer === 45,
    'tuzak dagilimi 10 dogru / 20 tuzak / 10 notr / 45 cevapsiz', r5.distribution);
  assert(r5.correctDisplay.traps && r5.correctDisplay.traps.includes(2) && r5.correctDisplay.trapTexts[0] === 'TuzakSik',
    'tuzak siklari host aciklamasinda isaretli', r5.correctDisplay);

  await sleep(300);
  const p1r5 = players[0].results.find((r) => r.index === 4);
  assert(p1r5 && p1r5.gain === 200 && p1r5.score === 900, 'Oyuncu1: dogru, +200 ile 900', p1r5);
  const p11r5 = players[10].results.find((r) => r.index === 4);
  assert(p11r5 && p11r5.trapped === true && p11r5.gain === -200 && p11r5.score === 500, 'Oyuncu11: tuzaga dustu, -200 ile 500', p11r5);
  const p21r5 = players[20].results.find((r) => r.index === 4);
  assert(p21r5 && p21r5.gain === -200 && p21r5.score === -200, 'Oyuncu21: tuzakla eksiye dustu (-200)', p21r5);
  const p31r5 = players[30].results.find((r) => r.index === 4);
  assert(p31r5 && !p31r5.correct && !p31r5.trapped && p31r5.gain === 0, 'Oyuncu31: notr yanlis, puan degismedi', p31r5);

  /* ---- final ---- */
  console.log('\nFinal');
  const finalH = once(host, 'game:ended');
  await emit(host, 'host:end_game', { pin: PIN, hostToken: HTOKEN });
  const fin = await finalH;
  await sleep(500);

  const expectedScore = (i) => {
    let s = 0;
    if (i <= 60) s += 100;
    if (i <= 40 || (i >= 61 && i <= 70)) s += 150;
    if (i <= 40) s += 250;
    // Soru 4 (risk):
    if (i <= 20) s += 200;
    else if (i <= 40) s -= 500;
    else if (i <= 60) s -= 100;
    else if (i <= 65) s += 1;
    else if (i <= 70) s -= 1;
    else if (i <= 75) s += 70;
    // Soru 5 (tuzak):
    if (i <= 10) s += 200;
    else if (i <= 30) s -= 200;
    return s;
  };
  const expectedRank = (i) => {
    const mine = expectedScore(i);
    let better = 0;
    for (let j = 1; j <= N; j++) if (expectedScore(j) > mine) better++;
    return better + 1;
  };

  let scoreOk = true, rankOk = true;
  for (const row of fin.full) {
    const i = Number(row.nickname.replace('Oyuncu', ''));
    if (row.score !== expectedScore(i)) { scoreOk = false; console.log('    skor farki', row, 'beklenen', expectedScore(i)); }
    if (row.rank !== expectedRank(i)) { rankOk = false; console.log('    sira farki', row, 'beklenen', expectedRank(i)); }
  }
  assert(fin.full.length === N, 'final listesinde ' + N + ' oyuncu var', fin.full.length);
  assert(scoreOk, 'tum skorlar beklendigi gibi');
  assert(rankOk, 'tum siralar beklendigi gibi (beraberlik dahil)');
  assert(fin.podium.length === 3 && fin.podium.every((p) => p.score === 900), 'podyum 900 puanlik oyunculardan olusuyor', fin.podium);

  const pf = players[75].final; // Oyuncu76: 0 puan
  assert(pf && pf.you && pf.you.score === 0 && pf.you.rank === 36, 'Oyuncu76 finalde 0 puan / sira 36', pf && pf.you);
  const pneg = players[20].final; // Oyuncu21: eksi puan
  assert(pneg && pneg.you && pneg.you.score === -200 && pneg.you.rank === 76, 'Oyuncu21 finalde -200 / sira 76 (eksi skor destegi)', pneg && pneg.you);

  /* ---- host yeniden baglanma (sayfa yenileme) ---- */
  const host2 = await connect();
  const rec = await emit(host2, 'host:reclaim', { pin: PIN, hostToken: HTOKEN });
  assert(rec.ok && rec.snapshot.state === 'ended' && rec.snapshot.final.full.length === N, 'host oturumu geri alabildi (yenileme senaryosu)');
  host2.close();

  console.log('\nSonuc: ' + (checks - failures) + '/' + checks + ' kontrol gecti' + (failures ? ' | ' + failures + ' HATA' : ''));
  players.forEach((p) => p.socket.close());
  host.close();
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('SIM HATASI:', err);
  process.exit(2);
});
