// LUNIQUE 결제 서버 (PayPal) — 66일차
// 브라우저는 절대 코인을 스스로 지급하지 않는다. 모든 지급은 여기서 PayPal에 진위를
// 확인한 뒤에만 일어난다. npm 의존성 0 — GitHub 웹 업로드만으로 배포된다.
//
// 필요한 Netlify 환경변수 (Site settings > Environment variables):
//   PAYPAL_ENV        "sandbox" 또는 "live"
//   PAYPAL_CLIENT_ID  PayPal 앱의 Client ID
//   PAYPAL_SECRET     PayPal 앱의 Secret
//   PAYPAL_PLAN_ID    구독 플랜 ID (P-로 시작)
//   PAYPAL_WEBHOOK_ID 웹훅 ID (WH-… 아님, 대시보드의 Webhook ID)
//   FIREBASE_WEB_API_KEY  Firebase 웹 API 키 (index.html의 apiKey와 같은 값)
//   FIREBASE_SA_B64   Firebase 서비스 계정 JSON을 base64로 인코딩한 값

const crypto = require('crypto');

// 코인 묶음 — index.html의 COIN_PACKS와 반드시 일치해야 한다.
const PACKS = { 100: '0.99', 550: '4.99', 1200: '8.99' };
const CURRENCY = 'USD';

const PP_BASE = (process.env.PAYPAL_ENV === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// ---------- PayPal 토큰 ----------
let ppTok = null, ppTokExp = 0;
async function paypalToken() {
  if (ppTok && Date.now() < ppTokExp - 60000) return ppTok;
  const basic = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const r = await fetch(PP_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('paypal-auth: ' + JSON.stringify(j).slice(0, 200));
  ppTok = j.access_token;
  ppTokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return ppTok;
}
async function pp(method, path, body) {
  const tok = await paypalToken();
  const r = await fetch(PP_BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (e) {}
  return { status: r.status, body: j };
}

// ---------- Firebase: 로그인 토큰 → uid ----------
async function verifyUser(idToken) {
  if (!idToken) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_WEB_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const j = await r.json();
  const u = j.users && j.users[0];
  return u ? u.localId : null;
}

// ---------- Firestore (서비스 계정으로 서버 전용 쓰기) ----------
let gTok = null, gTokExp = 0;
function sa() { return JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8')); }
async function googleToken() {
  if (gTok && Date.now() < gTokExp - 60000) return gTok;
  const acct = sa();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: acct.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(acct.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + sig
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('google-auth: ' + JSON.stringify(j).slice(0, 200));
  gTok = j.access_token;
  gTokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return gTok;
}
function fsBase() { return 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)'; }
function fsDoc(path) { return 'projects/' + sa().project_id + '/databases/(default)/documents/' + path; }

async function fsCommit(writes) {
  const tok = await googleToken();
  const r = await fetch(fsBase() + '/documents:commit', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes })
  });
  const j = await r.json();
  return { status: r.status, body: j };
}
async function fsGet(path) {
  const tok = await googleToken();
  const r = await fetch(fsBase() + '/documents/' + path, { headers: { Authorization: 'Bearer ' + tok } });
  if (r.status === 404) return null;
  return await r.json();
}
function fInt(n) { return { integerValue: String(n) }; }
function fStr(s) { return { stringValue: String(s) }; }
function fBool(b) { return { booleanValue: !!b }; }

// 구매 1건 = 코인 지급 1번만. purchases 문서를 '없을 때만 생성' 조건으로 함께 커밋해서
// 같은 주문번호로 두 번 지급되는 일을 원천 차단한다.
async function creditCoins(uid, orderId, coins, amount) {
  const res = await fsCommit([
    {
      update: {
        name: fsDoc('players/' + uid + '/purchases/' + orderId),
        fields: { type: fStr('coins'), coins: fInt(coins), usd: fStr(amount), at: fStr(new Date().toISOString()) }
      },
      currentDocument: { exists: false }
    },
    {
      transform: {
        document: fsDoc('players/' + uid),
        fieldTransforms: [{ fieldPath: 'coins', increment: fInt(coins) }]
      }
    }
  ]);
  if (res.status === 200) return 'credited';
  const msg = JSON.stringify(res.body);
  if (msg.indexOf('ALREADY_EXISTS') !== -1 || msg.indexOf('already exists') !== -1) return 'duplicate';
  throw new Error('firestore-commit: ' + msg.slice(0, 300));
}

async function setSubscription(uid, active, subId) {
  const fields = {
    subscription: { mapValue: { fields: {
      active: fBool(active), plan: fStr('premium'),
      paypalSubId: fStr(subId || ''),
      updatedAt: fStr(new Date().toISOString())
    } } }
  };
  const writes = [{ update: { name: fsDoc('players/' + uid), fields }, updateMask: { fieldPaths: ['subscription'] } }];
  if (subId) {
    writes.push({ update: { name: fsDoc('paypalSubs/' + subId), fields: { uid: fStr(uid) } } });
  }
  const res = await fsCommit(writes);
  if (res.status !== 200) throw new Error('firestore-sub: ' + JSON.stringify(res.body).slice(0, 300));
}

// ---------- 응답 헬퍼 ----------
const ok = (obj) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const bad = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch (e) { return bad(400, 'bad json'); }
  const action = req.action;

  try {
    // ===== 웹훅 (PayPal이 호출 — 로그인 없음, 서명 검증으로 진위 확인) =====
    if (action === undefined && event.headers['paypal-transmission-id']) {
      const h = event.headers;
      const ver = await pp('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h['paypal-auth-algo'],
        cert_url: h['paypal-cert-url'],
        transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'],
        transmission_time: h['paypal-transmission-time'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: req
      });
      if (!ver.body || ver.body.verification_status !== 'SUCCESS') return bad(400, 'bad signature');
      const type = req.event_type || '';
      const resource = req.resource || {};
      if (type === 'BILLING.SUBSCRIPTION.CANCELLED' || type === 'BILLING.SUBSCRIPTION.EXPIRED' || type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
        const subId = resource.id;
        const map = subId ? await fsGet('paypalSubs/' + subId) : null;
        const uid = map && map.fields && map.fields.uid && map.fields.uid.stringValue;
        if (uid) await setSubscription(uid, false, subId);
      }
      return ok({ received: true });
    }

    // ===== 이하 유저 요청 — Firebase 로그인 토큰 필수 =====
    const idToken = (event.headers.authorization || '').replace(/^Bearer /, '');
    const uid = await verifyUser(idToken);
    if (!uid) return bad(401, 'login required');

    if (action === 'create-order') {
      const coins = parseInt(req.pack, 10);
      const price = PACKS[coins];
      if (!price) return bad(400, 'unknown pack');
      const r = await pp('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: CURRENCY, value: price },
          custom_id: uid,
          description: 'LUNIQUE ' + coins + ' coins'
        }]
      });
      if (r.status !== 201 && r.status !== 200) return bad(502, 'paypal create failed');
      return ok({ id: r.body.id });
    }

    if (action === 'capture-order') {
      const orderID = String(req.orderID || '');
      if (!orderID) return bad(400, 'no order');
      const r = await pp('POST', '/v2/checkout/orders/' + orderID + '/capture', {});
      const already = r.status === 422 && JSON.stringify(r.body).indexOf('ORDER_ALREADY_CAPTURED') !== -1;
      let order = r.body;
      if (already) {
        const g = await pp('GET', '/v2/checkout/orders/' + orderID);
        order = g.body;
      } else if (r.status !== 201 && r.status !== 200) {
        return bad(502, 'capture failed');
      }
      if (order.status !== 'COMPLETED') return bad(400, 'not completed');
      const pu = (order.purchase_units && order.purchase_units[0]) || {};
      const cap = pu.payments && pu.payments.captures && pu.payments.captures[0];
      const amount = (cap && cap.amount) || pu.amount || {};
      if (pu.custom_id !== uid) return bad(403, 'order belongs to another account');
      const coins = Object.keys(PACKS).find(c => PACKS[c] === amount.value);
      if (!coins || amount.currency_code !== CURRENCY) return bad(400, 'amount mismatch');
      const result = await creditCoins(uid, orderID, parseInt(coins, 10), amount.value);
      return ok({ credited: result === 'credited', coins: parseInt(coins, 10), duplicate: result === 'duplicate' });
    }

    if (action === 'activate-sub') {
      const subID = String(req.subscriptionID || '');
      if (!subID) return bad(400, 'no subscription');
      const r = await pp('GET', '/v1/billing/subscriptions/' + subID);
      if (r.status !== 200) return bad(502, 'lookup failed');
      const s = r.body;
      if (s.plan_id !== process.env.PAYPAL_PLAN_ID) return bad(400, 'wrong plan');
      if (s.status !== 'ACTIVE' && s.status !== 'APPROVED') return bad(400, 'not active: ' + s.status);
      if (s.custom_id && s.custom_id !== uid) return bad(403, 'subscription belongs to another account');
      await setSubscription(uid, true, subID);
      return ok({ active: true });
    }

    if (action === 'cancel-sub') {
      const doc = await fsGet('players/' + uid);
      const f = doc && doc.fields && doc.fields.subscription && doc.fields.subscription.mapValue && doc.fields.subscription.mapValue.fields;
      const subId = f && f.paypalSubId && f.paypalSubId.stringValue;
      if (subId) {
        const r = await pp('POST', '/v1/billing/subscriptions/' + subId + '/cancel', { reason: 'user request' });
        if (r.status !== 204 && r.status !== 200) {
          const g = await pp('GET', '/v1/billing/subscriptions/' + subId);
          if (!g.body || (g.body.status !== 'CANCELLED' && g.body.status !== 'EXPIRED')) return bad(502, 'cancel failed');
        }
      }
      await setSubscription(uid, false, subId || '');
      return ok({ active: false });
    }

    return bad(400, 'unknown action');
  } catch (e) {
    return bad(500, String(e && e.message || e).slice(0, 300));
  }
};
