// LUNIQUE 대화 서버 (Netlify Edge Function) — 68일차 전면 개정: 코인 차감 서버화
//
// 예전에는 이 함수가 Gemini 중계만 하고, 무료 횟수·코인 차감은 유저 브라우저가 했다.
// 그래서 브라우저를 조작하면 코인 없이 무한 대화가 가능했다(치팅).
// 이제 대화 요청이 올 때마다 이 서버가 직접:
//   1) 로그인 토큰을 확인하고 (누구인지)
//   2) Firestore에서 구독/무료 횟수/코인을 읽어 판정하고 (보낼 자격이 있는지)
//   3) 자격이 있으면 서버 권한으로 직접 차감한 뒤 (브라우저는 손 못 댐)
//   4) Gemini에 중계한다. Gemini가 실패하면 차감을 되돌린다.
//
// 필요한 Netlify 환경 변수:
//   GEMINI_API_KEY        (기존) Gemini API 키
//   FIREBASE_WEB_API_KEY  (기존) Firebase 웹 API 키 — 로그인 토큰 확인용
//   FIREBASE_SA_B64       (기존) Firebase 서비스 계정 JSON(base64) — Firestore 서버 권한
//   SIM_KEY               (신규) 로컬 QA 시뮬레이터 전용 통행 키. 미설정이면 우회 자체가 꺼진다.
//
// index.html과 반드시 일치해야 하는 값: FREE_DAILY_LIMIT=10, COST_PER_MESSAGE=2
const FREE_DAILY_LIMIT = 10;
const COST_PER_MESSAGE = 2;

// ---------- 판정 (순수 함수 — 로컬에서 node로 단위 테스트한다) ----------
// player: { coins, subActive, freeMsgDate, freeMsgCount }, today: 'YYYY-MM-DD'(UTC)
// 반환: { mode: 'subscription'|'free'|'coin'|'blocked', freeUsedAfter?, coinsAfter? }
export function decideQuota(player, today) {
  if (player.subActive) return { mode: 'subscription' };
  const usedToday = (player.freeMsgDate === today) ? player.freeMsgCount : 0;
  if (usedToday < FREE_DAILY_LIMIT) return { mode: 'free', freeUsedAfter: usedToday + 1 };
  if (player.coins >= COST_PER_MESSAGE) return { mode: 'coin', coinsAfter: player.coins - COST_PER_MESSAGE };
  return { mode: 'blocked' };
}

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Firestore 문서(REST 형식) → 판정에 쓰는 평범한 값들로 변환 (이것도 순수 함수)
export function parsePlayerDoc(doc) {
  const f = (doc && doc.fields) || {};
  const int = (v) => (v && v.integerValue !== undefined) ? parseInt(v.integerValue, 10)
    : (v && v.doubleValue !== undefined) ? Math.floor(v.doubleValue) : 0;
  const sub = f.subscription && f.subscription.mapValue && f.subscription.mapValue.fields;
  return {
    coins: int(f.coins),
    subActive: !!(sub && sub.active && sub.active.booleanValue === true),
    freeMsgDate: (f.freeMsgDate && f.freeMsgDate.stringValue) || '',
    freeMsgCount: int(f.freeMsgCount)
  };
}

// ---------- Firebase: 로그인 토큰 → uid ----------
async function verifyUser(idToken, webApiKey) {
  if (!idToken) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + webApiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const u = j.users && j.users[0];
  return u ? { uid: u.localId, email: (u.email || '').toLowerCase() } : null;
}

// ---------- Firestore (서비스 계정 = 서버 전용 권한) ----------
let gTok = null, gTokExp = 0, saCache = null;
function sa() {
  if (!saCache) saCache = JSON.parse(atob(Deno.env.get('FIREBASE_SA_B64')));
  return saCache;
}
function b64url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function googleToken() {
  if (gTok && Date.now() < gTokExp - 60000) return gTok;
  const acct = sa();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: acct.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(acct.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64url(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('google-auth 실패');
  gTok = j.access_token;
  gTokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return gTok;
}
function fsBase() { return 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)'; }
function fsDocName(path) { return 'projects/' + sa().project_id + '/databases/(default)/documents/' + path; }

async function fsGet(path) {
  const tok = await googleToken();
  const r = await fetch(fsBase() + '/documents/' + path, { headers: { Authorization: 'Bearer ' + tok } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('firestore-get 실패 ' + r.status);
  return await r.json();
}
async function fsCommit(writes) {
  const tok = await googleToken();
  const r = await fetch(fsBase() + '/documents:commit', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes })
  });
  if (!r.ok) throw new Error('firestore-commit 실패 ' + r.status);
  return await r.json();
}
const fInt = (n) => ({ integerValue: String(n) });
const fStr = (s) => ({ stringValue: String(s) });

// 판정 결과에 따라 실제로 차감한다. 롤백에 필요한 정보를 돌려준다.
async function applyCharge(uid, decision, today) {
  const doc = fsDocName('players/' + uid);
  if (decision.mode === 'free') {
    if (decision.freeUsedAfter === 1) {
      // 오늘 첫 무료 대화 — 날짜를 오늘로 새로 찍고 1로 시작
      await fsCommit([{
        update: { name: doc, fields: { freeMsgDate: fStr(today), freeMsgCount: fInt(1) } },
        updateMask: { fieldPaths: ['freeMsgDate', 'freeMsgCount'] }
      }]);
    } else {
      await fsCommit([{ transform: { document: doc, fieldTransforms: [{ fieldPath: 'freeMsgCount', increment: fInt(1) }] } }]);
    }
    return { rollback: [{ transform: { document: doc, fieldTransforms: [{ fieldPath: 'freeMsgCount', increment: fInt(-1) }] } }] };
  }
  if (decision.mode === 'coin') {
    await fsCommit([{ transform: { document: doc, fieldTransforms: [{ fieldPath: 'coins', increment: fInt(-COST_PER_MESSAGE) }] } }]);
    return { rollback: [{ transform: { document: doc, fieldTransforms: [{ fieldPath: 'coins', increment: fInt(COST_PER_MESSAGE) }] } }] };
  }
  return { rollback: null }; // subscription — 차감 없음
}

// ---------- 로컬 AI 갈림길 (73일차) ----------
// 무검열 모델을 얹은 GPU 서버로 "허락된 계정만" 보낸다. 나머지는 지금까지와 똑같이 구글로 간다.
//
// 켜고 끄는 곳은 코드가 아니라 Firestore 문서 `config/localAI` 다.
//   { enabled: true/false, url: "https://xxx-8000.proxy.runpod.net", emails: ["a@b.com", ...] }
// GPU 서버 주소는 켤 때마다 바뀌는데, 이 문서만 고치면 되므로 **다시 배포하지 않아도 된다.**
// 문서가 없거나 enabled=false 면 아무 일도 일어나지 않는다(기존 동작 그대로).
let lcCfg = null, lcAt = 0;
async function localAIConfig() {
  if (lcCfg && Date.now() - lcAt < 60000) return lcCfg;   // 1분 캐시 — 매 턴 읽지 않는다
  let c = { enabled: false, url: '', emails: [] };
  try {
    const f = ((await fsGet('config/localAI')) || {}).fields || {};
    c = {
      enabled: !!(f.enabled && f.enabled.booleanValue === true),
      url: ((f.url && f.url.stringValue) || '').replace(/\/+$/, ''),
      emails: (((f.emails || {}).arrayValue || {}).values || [])
        .map((v) => (v.stringValue || '').toLowerCase()).filter(Boolean)
    };
  } catch (e) { /* 못 읽으면 그냥 구글로 간다 */ }
  lcCfg = c; lcAt = Date.now();
  return c;
}

// 제미나이 스키마(대문자 타입) → 표준 JSON 스키마(소문자)
function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') o.type = v.toLowerCase();
    else if (k === 'nullable') continue;
    else if (k === 'properties') { o.properties = {}; for (const [a, b] of Object.entries(v)) o.properties[a] = toJsonSchema(b); }
    else if (k === 'items') o.items = toJsonSchema(v);
    else o[k] = v;
  }
  return o;
}

// 제미나이 요청 → OpenAI 요청
function toOpenAIBody(g) {
  const messages = [];
  const sys = g.system_instruction || g.systemInstruction;
  const sysText = sys && sys.parts && sys.parts.map((p) => p.text).join('\n');
  if (sysText) messages.push({ role: 'system', content: sysText });
  (g.contents || []).forEach((c) => {
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: (c.parts || []).map((p) => p.text).join('\n') });
  });
  const gc = g.generationConfig || {};
  const b = {
    model: 'lq', messages,
    temperature: typeof gc.temperature === 'number' ? gc.temperature : 0.9,
    // 73일차 실측: 반복 억제 1.15는 한국어와 JSON 형식을 동시에 깨뜨린다. 1.0으로 둔다.
    repetition_penalty: 1.0,
    max_tokens: gc.maxOutputTokens || 4096,
    stream: true, stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false }
  };
  if (gc.responseSchema) { b.guided_json = toJsonSchema(gc.responseSchema); b.guided_decoding_backend = 'xgrammar'; }
  return b;
}

// OpenAI 스트림 → 제미나이 스트림 (브라우저 코드를 하나도 안 고치기 위함)
function openAIToGemini(stream) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '', usage = null;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let j; try { j = JSON.parse(p); } catch (e) { continue; }
        if (j.usage) usage = j.usage;
        const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (d) ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: d }] } }] }) + '\n\n'));
      }
    },
    flush(ctrl) {
      ctrl.enqueue(enc.encode('data: ' + JSON.stringify({
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: usage ? {
          promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens,
          totalTokenCount: usage.total_tokens, cachedContentTokenCount: 0
        } : undefined
      }) + '\n\n'));
    }
  }));
}

// ---------- 본체 ----------
export default async (request) => {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: '서버에 GEMINI_API_KEY 환경 변수가 설정되어 있지 않아요.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST 요청만 허용돼요.' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const requestBody = await request.text();

  // ---- 자격 확인 + 차감 ----
  // 로컬 QA 시뮬레이터 통행 키(운영자 전용). SIM_KEY 환경변수가 없으면 이 우회는 아예 작동하지 않는다.
  const simKey = Deno.env.get('SIM_KEY');
  const isSim = !!(simKey && request.headers.get('x-sim-key') === simKey);

  let quotaHeaders = {};
  let rollback = null;
  let userEmail = '';
  if (!isSim) {
    const authHeader = request.headers.get('authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const who = await verifyUser(idToken, Deno.env.get('FIREBASE_WEB_API_KEY'));
    const uid = who && who.uid;
    userEmail = (who && who.email) || '';
    if (!uid) {
      return new Response(JSON.stringify({ error: 'auth', message: '로그인이 필요해요.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    let decision, player;
    try {
      const today = todayUTC();
      player = parsePlayerDoc(await fsGet('players/' + uid));
      decision = decideQuota(player, today);
      if (decision.mode === 'blocked') {
        return new Response(JSON.stringify({ error: 'quota', coins: player.coins }),
          { status: 402, headers: { 'Content-Type': 'application/json' } });
      }
      rollback = (await applyCharge(uid, decision, today)).rollback;
    } catch (e) {
      // 판정/차감 자체가 죽으면 유저를 막지 않는다 — 서버 장애로 게임까지 멈추는 게 더 나쁘다.
      // (이 경우 이번 한 턴은 차감 없이 나간다. Netlify 함수 로그에 남는다.)
      console.error('quota-error', e && e.message);
      rollback = null;
    }
    if (decision) {
      quotaHeaders['x-quota-mode'] = decision.mode;
      if (decision.mode === 'coin') quotaHeaders['x-coins-left'] = String(decision.coinsAfter);
      if (decision.mode === 'free') quotaHeaders['x-free-used'] = String(decision.freeUsedAfter);
    }
  }

  // ---- 로컬 AI로 보낼 사람인가 (73일차) ----
  // 허락된 계정이고, 서버가 켜져 있고, 실제로 대답할 때만 로컬로 간다.
  // 하나라도 어긋나면 아래 구글 중계로 그대로 내려간다 — 유저는 끊김을 느끼지 않는다.
  let localBody = null, localStatus = 0;
  if (!isSim && userEmail) {
    const cfg = await localAIConfig();
    if (cfg.enabled && cfg.url && cfg.emails.includes(userEmail)) {
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 20000);   // 20초 안에 시작 못 하면 구글로 돌아간다
        const lr = await fetch(cfg.url + '/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toOpenAIBody(JSON.parse(requestBody))), signal: ac.signal
        });
        clearTimeout(to);
        if (lr.ok && lr.body) { localBody = openAIToGemini(lr.body); localStatus = 200; quotaHeaders['x-ai'] = 'local'; }
        else console.error('local-ai-status', lr.status);
      } catch (e) { console.error('local-ai-error', e && e.message); }
    }
  }

  // ---- Gemini 중계 ----
  const upstream = localBody ? { status: localStatus, body: localBody } : await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: requestBody
    }
  );

  // Gemini가 시작조차 못 했으면(과부하·오류) 방금 차감을 되돌린다.
  if (upstream.status !== 200 && rollback) {
    try { await fsCommit(rollback); } catch (e) { console.error('rollback-error', e && e.message); }
    rollback = null;
  }

  // 72일차: 200을 받았어도 안전 필터에 막히면 **내용이 한 글자도 안 온다.**
  // 화면에서는 "이번 턴은 없던 것으로 한다"고 안내하는데 서버에서는 코인이 이미 빠진 뒤였다.
  // 그래서 흘려보내면서 본문이 왔는지 지켜보고, 끝까지 한 글자도 없으면 그때 되돌린다.
  // (중계는 그대로 통과시키므로 응답이 느려지지 않는다)
  let body = upstream.body;
  if (upstream.status === 200 && rollback && body) {
    const 되돌릴것 = rollback;
    rollback = null;
    let 글자옴 = false;
    const 디코더 = new TextDecoder();
    const 감시 = new TransformStream({
      transform(chunk, ctrl) {
        if (!글자옴) {
          const 조각 = 디코더.decode(chunk, { stream: true });
          // 구글 스트림은 {"text": "..."} 형태로 본문을 담아 보낸다. 빈 문자열은 세지 않는다.
          if (/"text"\s*:\s*"[^"]/.test(조각)) 글자옴 = true;
        }
        ctrl.enqueue(chunk);
      },
      async flush() {
        if (!글자옴) {
          try { await fsCommit(되돌릴것); } catch (e) { console.error('rollback-empty-error', e && e.message); }
        }
      }
    });
    body = body.pipeThrough(감시);
  }

  // 구글 쪽 응답을 그대로(스트리밍 상태 그대로) 전달한다.
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...quotaHeaders
    }
  });
};

export const config = { path: '/api/chat' };
