'use strict';
// Majority Game · 多数派ゲーム
// Players:   https://<your-site>/
// Organizer: https://<your-site>/admin?key=<ADMIN_KEY>
// Print QR:  https://<your-site>/print
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const APP_HTML = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

const Q = (en, ja, aEn, aJa, bEn, bJa) => ({ q: { en, ja }, a: [{ en: aEn, ja: aJa }, { en: bEn, ja: bJa }] });
const DEFAULT_QUESTIONS = [
  Q('Which would you rather have free for life?', '一生無料になるなら、どっち？',
    'All taxi rides', 'タクシー代すべて', 'All restaurant meals', '外食代すべて'),
  Q('Which phone screen feels more like yours?', 'あなたのスマホ画面に近いのは？',
    'Every notification cleared', '通知は常にゼロ', '9,999 unread texts, no problem', '未読9,999件でも平気'),
  Q('Which life problem would you rather endure?', '我慢するならどっち？',
    'Biting my tongue every time I eat', '食事のたびに舌を噛む', 'Getting soap in my eyes every time I wash my face', '洗顔のたびに目に石鹸が入る'),
  Q('If Elon Musk invited you personally, would you go on a trip to space?', 'イーロン・マスクから直々に誘われたら、宇宙旅行に行く？',
    'Yes', '行く', 'No', '行かない'),
  Q('Who would you rather have a 30-minute conversation with?', '30分話せるなら、どっち？',
    'Yourself in 10 years', '10年後の自分', 'Yourself 10 years ago', '10年前の自分'),
  Q('Which superpower would you choose?', '手に入れるなら、どっちの超能力？',
    'Knowing the history of every object you touch', '触れた物の歴史がすべてわかる', 'The ability to talk to animals', '動物と話せる'),
  Q('Which would you rather come to work in?', '出社するなら、どっち？',
    'A Mickey Mouse suit', 'ミッキーマウスの着ぐるみ', 'Shoes that play music with every step', '一歩ごとに音楽が鳴る靴'),
  Q('Which would you choose for your last meal on earth?', '地球最後の食事に選ぶなら？',
    'Premium sushi, but the rice is onigiri-sized', '最高級の寿司（ただしシャリはおにぎりサイズ）',
    'Unlimited Kentucky Fried Chicken, but it has all gone cold', 'ケンタッキー食べ放題（ただし全部冷めている）'),
  Q('Stranded on an island, would you rather your smartphone have…', '無人島で、スマホはどっちの状態がいい？',
    'Battery at 5%, but good data and Wi-Fi', '電池残り5%、でも電波もWi-Fiも良好',
    'Battery at 100%, but bad data and no Wi-Fi', '電池100%、でも電波が弱くWi-Fiなし'),
  Q('If you won the Year-End Jumbo Lottery, what would you do?', '年末ジャンボ宝くじが当たったら、どうする？',
    "Spend it right away on something I've wanted for a long time", 'ずっと欲しかった物にすぐ使う', 'Save or invest it', '貯金・投資する'),
  Q('If you could only wear one group of colors for the rest of your life, which would you choose?', '一生着る服の色を選ぶなら、どっち？',
    'Black, white or beige only', '黒・白・ベージュだけ', 'Any color except those', 'それ以外の色ならなんでも'),
  Q('Which better describes your morning soundtrack before work?', '出勤前の朝に聴くのは、どっち？',
    'Something to energize me for the workday', '仕事に向けて気分を上げる曲', 'Something calming, or no music at all', '落ち着く曲、または音楽なし'),
];
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- state ----------
let questions = clone(DEFAULT_QUESTIONS);
let game = { phase: 'lobby', idx: -1, endsAt: null, timer: 20 }; // lobby | question | locked | reveal | final
let results = []; // results[i] = { counts:[a,b], winners:[...] }
let players = {}; // id -> { name, votes: [] }
let qver = 1;

try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(d.questions) && d.questions.length) questions = d.questions;
  if (d.game && d.game.phase) game = d.game;
  if (Array.isArray(d.results)) results = d.results;
  if (d.players && typeof d.players === 'object') players = d.players;
} catch (e) { /* first run */ }

let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify({ questions, game, results, players }), () => {}), 300);
}

let lockT = null;
function scheduleLock() {
  clearTimeout(lockT);
  if (game.phase !== 'question' || !game.endsAt) return;
  const fire = () => { if (game.phase === 'question') { game.phase = 'locked'; game.endsAt = null; save(); broadcast(); } };
  const ms = game.endsAt - Date.now();
  if (ms <= 0) fire(); else lockT = setTimeout(fire, ms + 300);
}

const voted = (p, i) => p.votes[i] === 0 || p.votes[i] === 1;
function scoreOf(p) {
  let s = 0;
  results.forEach((r, i) => { if (r && r.winners.includes(p.votes[i])) s++; });
  return s;
}
function board() {
  const list = Object.entries(players).map(([id, p]) => ({ id, name: p.name, score: scoreOf(p) }));
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  list.forEach((x) => { x.rank = 1 + list.filter((y) => y.score > x.score).length; });
  return list;
}
function liveCounts(i) {
  const c = [0, 0];
  for (const p of Object.values(players)) if (voted(p, i)) c[p.votes[i]]++;
  return c;
}
function top(b) {
  if (!b.length || b[0].score === 0) return [];
  return b.filter((x) => x.score === b[0].score).map((x) => ({ name: x.name, score: x.score }));
}
const asked = () => results.filter(Boolean).length;

// ---------- views ----------
function common() {
  return { phase: game.phase, idx: game.idx, total: questions.length, endsAt: game.endsAt, now: Date.now(),
    n: Object.keys(players).length, asked: asked() };
}
function playerView(id) {
  const v = common();
  const i = game.idx;
  const p = players[id];
  v.q = i >= 0 ? questions[i] : null;
  v.result = game.phase === 'reveal' ? results[i] : null;
  v.me = null;
  if (p) {
    const b = board();
    const me = b.find((x) => x.id === id);
    v.me = { name: p.name, score: me.score, rank: me.rank, vote: voted(p, i) ? p.votes[i] : null };
    if (game.phase === 'final') {
      v.winners = top(b);
      v.history = [];
      results.forEach((r, k) => {
        if (r) v.history.push({ n: k + 1, q: questions[k], vote: voted(p, k) ? p.votes[k] : null, counts: r.counts, winners: r.winners });
      });
    }
  }
  return v;
}
function adminView() {
  const v = common();
  const i = game.idx;
  const b = board();
  return Object.assign(v, {
    admin: true, timer: game.timer, qver, questions, results,
    counts: i >= 0 ? liveCounts(i) : [0, 0],
    answered: i >= 0 ? Object.values(players).filter((p) => voted(p, i)).length : 0,
    players: b.map((x) => ({ id: x.id, name: x.name, score: x.score, rank: x.rank, answered: i >= 0 && voted(players[x.id], i) })),
    winners: top(b),
  });
}

const clients = new Set();
function broadcast() {
  const av = JSON.stringify(adminView());
  for (const c of clients) c.res.write('data: ' + (c.admin ? av : JSON.stringify(playerView(c.id))) + '\n\n');
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

// ---------- actions ----------
function openQuestion(i) {
  game.idx = i;
  game.phase = 'question';
  game.endsAt = game.timer > 0 ? Date.now() + game.timer * 1000 : null;
  results[i] = null;
}
function cleanQuestions(arr) {
  if (!Array.isArray(arr) || !arr.length || arr.length > 50) return null;
  const s = (x) => String(x == null ? '' : x).trim().slice(0, 200);
  const out = [];
  for (const it of arr) {
    const q = { en: s(it && it.q && it.q.en), ja: s(it && it.q && it.q.ja) };
    const a = [0, 1].map((k) => ({ en: s(it && it.a && it.a[k] && it.a[k].en), ja: s(it && it.a && it.a[k] && it.a[k].ja) }));
    if (!(q.en || q.ja) || a.some((o) => !(o.en || o.ja))) return null;
    out.push({ q, a });
  }
  return out;
}
function act(b) {
  const a = b.act;
  if (a === 'join') {
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return { error: 'Please enter a name · 名前を入力してください' };
    if (Object.keys(players).length >= 300) return { error: 'Game is full' };
    const id = crypto.randomBytes(9).toString('base64url');
    players[id] = { name, votes: [] };
    return { id };
  }
  if (a === 'vote') {
    const p = players[b.id];
    if (!p) return { error: 'unknown player' };
    if (game.phase !== 'question' || (game.endsAt && Date.now() > game.endsAt + 1500)) return { error: 'Answers are closed · 回答は締め切られました' };
    if (b.choice !== 0 && b.choice !== 1) return { error: 'bad choice' };
    while (p.votes.length < game.idx) p.votes.push(null);
    p.votes[game.idx] = b.choice;
    return { ok: true };
  }
  if (b.key !== ADMIN_KEY) return { error: 'Wrong admin key' };
  const lobbyOnly = 'Questions can only be edited in the lobby (before Start or after Reset)';
  switch (a) {
    case 'start': if (game.phase === 'lobby' && questions.length) { results = []; openQuestion(0); } break;
    case 'close': if (game.phase === 'question') { game.phase = 'locked'; game.endsAt = null; } break;
    case 'reveal':
      if (game.phase === 'question' || game.phase === 'locked') {
        const counts = liveCounts(game.idx);
        const max = Math.max(...counts);
        results[game.idx] = { counts, winners: max === 0 ? [] : [0, 1].filter((k) => counts[k] === max) };
        game.phase = 'reveal'; game.endsAt = null;
      }
      break;
    case 'next': if (game.phase === 'reveal' && game.idx < questions.length - 1) openQuestion(game.idx + 1); break;
    case 'final': if (game.phase === 'reveal') game.phase = 'final'; break;
    case 'reset':
      game.phase = 'lobby'; game.idx = -1; game.endsAt = null; results = [];
      for (const p of Object.values(players)) p.votes = [];
      break;
    case 'clearPlayers': if (game.phase === 'lobby') players = {}; break;
    case 'kick': delete players[b.pid]; break;
    case 'timer': { const t = Number(b.secs); if (Number.isFinite(t) && t >= 0 && t <= 600) game.timer = Math.round(t); break; }
    case 'questions': {
      if (game.phase !== 'lobby') return { error: lobbyOnly };
      const qs = cleanQuestions(b.questions);
      if (!qs) return { error: 'Every question needs question text and two options (EN or JA)' };
      questions = qs; qver++; break;
    }
    case 'defaults': if (game.phase !== 'lobby') return { error: lobbyOnly }; questions = clone(DEFAULT_QUESTIONS); qver++; break;
    default: return { error: 'unknown action' };
  }
  scheduleLock();
  return { ok: true };
}

// ---------- http ----------
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function printPage(url, svg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Majority Game · QR</title><style>
@page{size:A4;margin:14mm}
body{margin:0;font-family:-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",Meiryo,sans-serif;color:#14151c;background:#fff;text-align:center}
.wrap{max-width:170mm;margin:0 auto;padding:8mm 0}
h1{font-size:40px;margin:0 0 4px}h2{font-size:26px;margin:0 0 10px;font-weight:600;color:#555}
.qr{width:115mm;height:115mm;margin:6mm auto;border:3px solid #14151c;border-radius:8mm;padding:6mm;box-sizing:content-box}
.qr svg{width:100%;height:100%;display:block}
.scan{font-size:24px;font-weight:700;margin:4mm 0 1mm}.scan span{display:block;font-size:20px;font-weight:500;color:#555}
.url{font:600 16px ui-monospace,Menlo,monospace;margin:4mm 0 8mm;word-break:break-all}
.rules{font-size:15px;line-height:1.6;color:#333;border-top:1px solid #ddd;padding-top:6mm}
.noprint{margin:8mm 0}button{font:inherit;font-size:16px;padding:10px 22px;border-radius:10px;border:0;background:#14151c;color:#fff;cursor:pointer}
@media print{.noprint{display:none}}
</style></head><body><div class="wrap">
<h1>Majority Game</h1><h2>多数派ゲーム</h2>
<div class="qr">${svg}</div>
<div class="scan">Scan to join<span>QRコードを読み取って参加</span></div>
<div class="url">${esc(url)}</div>
<div class="rules">Pick the answer you think <b>most people</b> will choose. Match the majority = 1 point.<br>
みんなが選びそうな方を選んでください。多数派と一致すれば1ポイント。</div>
<div class="noprint"><button onclick="window.print()">Print · 印刷</button></div>
</div></body></html>`;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p === '/events') {
      const adminKey = u.searchParams.get('admin');
      const isAdmin = adminKey !== null;
      if (isAdmin && adminKey !== ADMIN_KEY) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const c = { res, admin: isAdmin, id: u.searchParams.get('id') || '' };
      clients.add(c);
      req.on('close', () => clients.delete(c));
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(isAdmin ? adminView() : playerView(c.id)) + '\n\n');
    } else if (p === '/api' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
      req.on('end', () => {
        let out;
        try { out = act(JSON.parse(body)); } catch (e) { out = { error: 'bad request' }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        if (!out.error) { save(); broadcast(); }
      });
    } else if (p === '/' || p === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(APP_HTML);
    } else if (p === '/qr.svg') {
      const svg = await QRCode.toString(baseUrl(req) + '/', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(svg);
    } else if (p === '/print') {
      const url = baseUrl(req) + '/';
      const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(printPage(url, svg));
    } else if (p === '/healthz') {
      res.writeHead(200); res.end('ok');
    } else { res.writeHead(404); res.end('Not found'); }
  } catch (e) {
    res.writeHead(500); res.end('error');
  }
}).listen(PORT, () => {
  scheduleLock();
  console.log(`Majority Game running on port ${PORT}`);
  console.log(`  Players:   http://localhost:${PORT}/`);
  console.log(`  Organizer: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  console.log(`  Print QR:  http://localhost:${PORT}/print`);
});
