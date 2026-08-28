// LUNIQUE 운영 대시보드 서버 (68일차) — 형균님 전용 집계 API
// admin.html이 호출한다. 허용된 관리자 계정(구글 로그인)만 응답을 받는다.
// npm 의존성 0. 필요한 환경변수: FIREBASE_WEB_API_KEY, FIREBASE_SA_B64 (결제 서버와 공유)

const crypto = require('crypto');
const ADMIN_EMAILS = ['kkfm1215@gmail.com'];

async function verifyAdmin(idToken) {
  if (!idToken) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_WEB_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  const j = await r.json();
  const u = j.users && j.users[0];
  if (!u || !ADMIN_EMAILS.includes(u.email)) return null;
  return u.localId;
}

let gTok = null, gTokExp = 0;
function sa() { return JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8')); }
async function googleToken() {
  if (gTok && Date.now() < gTokExp - 60000) return gTok;
  const acct = sa();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: acct.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(acct.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + sig
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('google-auth failed');
  gTok = j.access_token; gTokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return gTok;
}

async function runQuery(body) {
  const tok = await googleToken();
  const base = 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)/documents:runQuery';
  const r = await fetch(base, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await r.json();
}
const V = (f) => f === undefined ? undefined
  : f.integerValue !== undefined ? parseInt(f.integerValue, 10)
  : f.doubleValue !== undefined ? f.doubleValue
  : f.stringValue !== undefined ? f.stringValue
  : f.booleanValue !== undefined ? f.booleanValue : undefined;

const ok = (obj) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const bad = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  const idToken = (event.headers.authorization || '').replace(/^Bearer /, '');
  const admin = await verifyAdmin(idToken);
  if (!admin) return bad(403, 'admin only');

  try {
    const now = Date.now();
    const d7 = now - 7 * 86400000;
    // 클라이언트는 유저 기기의 현지 날짜를 freeMsgDate로 저장한다.
    // 서버는 UTC라서 그대로 비교하면 한국 아침 9시 전까지 어제로 계산됨 — 한국 시간 기준으로 맞춘다.
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);

    // ① 플레이어 집계 (최대 1000명 — 규모 커지면 페이지네이션 추가)
    const players = await runQuery({ structuredQuery: {
      from: [{ collectionId: 'players' }], limit: 1000,
      select: { fields: [{ fieldPath: 'freeMsgDate' }, { fieldPath: 'coins' }, { fieldPath: 'gender' }, { fieldPath: 'consentAt' }] }
    } });
    let totalPlayers = 0, activeToday = 0, newThisWeek = 0;
    const genders = {};
    (players || []).forEach(row => {
      if (!row.document) return;
      totalPlayers++;
      const f = row.document.fields || {};
      if (V(f.freeMsgDate) === today) activeToday++;
      if ((V(f.consentAt) || 0) >= d7) newThisWeek++;
      const g = V(f.gender) || '미입력';
      genders[g] = (genders[g] || 0) + 1;
    });

    // ② 스토리별 집계 (모든 유저의 storyStates를 컬렉션 그룹으로)
    const states = await runQuery({ structuredQuery: {
      from: [{ collectionId: 'storyStates', allDescendants: true }], limit: 5000,
      select: { fields: [{ fieldPath: 'collectionStatus' }, { fieldPath: 'lastTurnAt' }] }
    } });
    const stories = {};
    (states || []).forEach(row => {
      if (!row.document) return;
      const parts = row.document.name.split('/');
      const storyId = parts[parts.length - 1];
      const f = row.document.fields || {};
      const st = stories[storyId] = stories[storyId] || { started: 0, active: 0, completed: 0, failed: 0, last7d: 0 };
      st.started++;
      const status = V(f.collectionStatus) || 'active';
      if (st[status] !== undefined) st[status]++;
      if ((V(f.lastTurnAt) || 0) >= d7) st.last7d++;
    });

    // ③ 토큰 사용량 집계 (68일차) — 최근 8일치(usageStats/{YYYY-MM-DD}) 문서를 직접 하나씩 읽는다.
    // gemini-3.5-flash-lite 단가(2026-08 기준, 100만 토큰당): 새 입력 $0.30 / 캐시 입력 $0.03 / 출력 $2.50
    const PRICE = { fresh: 0.30, cached: 0.03, out: 2.50 };
    const dayKeys = [];
    for (let i = 0; i < 8; i++) dayKeys.push(new Date(now + 9 * 3600000 - i * 86400000).toISOString().slice(0, 10));
    const usageDocs = await Promise.all(dayKeys.map(async (day) => {
      const tok = await googleToken();
      const url = 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)/documents/usageStats/' + day;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
      if (r.status !== 200) return { day, promptTokens: 0, cachedTokens: 0, candidatesTokens: 0, turns: 0 };
      const j = await r.json();
      const f = j.fields || {};
      return { day, promptTokens: V(f.promptTokens) || 0, cachedTokens: V(f.cachedTokens) || 0, candidatesTokens: V(f.candidatesTokens) || 0, turns: V(f.turns) || 0 };
    }));
    const costOf = (d) => {
      const fresh = Math.max(0, d.promptTokens - d.cachedTokens);
      return fresh * PRICE.fresh / 1e6 + d.cachedTokens * PRICE.cached / 1e6 + d.candidatesTokens * PRICE.out / 1e6;
    };
    const usageDaily = usageDocs.map(d => ({ ...d, costUsd: costOf(d) })).reverse(); // 오래된 날짜부터
    const todayUsage = usageDocs[0];
    const week = usageDocs.reduce((a, d) => ({ turns: a.turns + d.turns, costUsd: a.costUsd + costOf(d) }), { turns: 0, costUsd: 0 });

    return ok({ at: now, totals: { players: totalPlayers, activeToday, newThisWeek, genders }, stories,
      usage: { daily: usageDaily, todayCostUsd: costOf(todayUsage), todayTurns: todayUsage.turns, week7CostUsd: week.costUsd, week7Turns: week.turns } });
  } catch (e) {
    return bad(500, String(e && e.message || e).slice(0, 200));
  }
};
