// LUNIQUE 푸시 알림 발송기 — 71일차
// 하루 한 번 각 유저의 저녁 시간에, 오래 대화가 끊긴 인연이 있으면 알림을 보낸다.
// npm 의존성 0 — GitHub 웹 업로드만으로 배포된다. (웹푸시 암호화를 직접 구현했다)
//
// 필요한 Netlify 환경변수:
//   VAPID_PUBLIC    공개 열쇠 (index.html의 VAPID_PUBLIC_KEY와 같은 값)
//   VAPID_PRIVATE   비밀 열쇠 (PEM을 base64로 감싼 값) — 절대 공개 금지
//   VAPID_SUBJECT   mailto:주소
//   FIREBASE_SA_B64 Firebase 서비스 계정 JSON을 base64로 인코딩한 값 (결제 서버와 같은 값)
//
// 실행 주기는 netlify.toml에 적혀 있다(매시 정각). 매시 돌면서, 유저의 현지 시각이
// 저녁 8시인 사람에게만 보낸다 — 나라가 달라도 각자 저녁에 받게 된다.

const crypto = require('crypto');

const IDLE_MS = 48 * 60 * 60 * 1000;      // 이만큼 대화가 없으면 알림 대상
const COOLDOWN_MS = 72 * 60 * 60 * 1000;  // 한 번 보내면 사흘은 다시 안 보낸다
const SEND_HOUR = 20;                     // 유저 현지 시각 저녁 8시
const MAX_PER_RUN = 400;                  // 한 번에 보낼 최대 인원 (안전장치)

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// ───────── Firebase (서비스 계정으로 Firestore REST 호출) ─────────
function sa() {
  return JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64 || '', 'base64').toString('utf8'));
}

async function googleToken(scope) {
  const key = sa();
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
          '&assertion=' + unsigned + '.' + sig
  });
  const j = await res.json();
  return j.access_token;
}

const DOCS = () => 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)/documents';

async function fsGet(path, tok) {
  const r = await fetch(DOCS() + path, { headers: { Authorization: 'Bearer ' + tok } });
  return r.ok ? r.json() : null;
}

// 알림을 켠 사람만 골라온다 (pushOn == true)
async function pushUsers(tok) {
  const r = await fetch(DOCS() + ':runQuery', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'players' }],
      where: { fieldFilter: { field: { fieldPath: 'pushOn' }, op: 'EQUAL', value: { booleanValue: true } } },
      limit: MAX_PER_RUN
    } })
  });
  if (!r.ok) return [];
  const rows = await r.json();
  return (rows || []).filter(x => x.document).map(x => x.document);
}

const str = (f, k) => (f && f[k] && f[k].stringValue) || '';
const int = (f, k) => { const v = f && f[k]; return v ? Number(v.integerValue || v.doubleValue || 0) : 0; };

// ───────── VAPID 서명 ─────────
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
                   b64u(JSON.stringify({ aud, exp: now + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:noreply@lunique' }));
  const pem = Buffer.from(process.env.VAPID_PRIVATE || '', 'base64').toString('utf8');
  // 웹푸시는 DER이 아니라 r‖s 형태(64바이트)의 서명을 요구한다
  const sig = crypto.createSign('SHA256').update(unsigned).sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + process.env.VAPID_PUBLIC;
}

// ───────── 본문 암호화 (RFC 8291, aes128gcm) ─────────
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encryptPayload(text, p256dhB64, authB64) {
  const uaPub = fromB64u(p256dhB64);            // 브라우저의 공개 열쇠 (65바이트)
  const authSecret = fromB64u(authB64);          // 브라우저가 준 비밀값 (16바이트)

  // 이번 발송에만 쓰는 일회용 열쇠 한 쌍
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();             // 65바이트
  const shared = ecdh.computeSecret(uaPub);

  const salt = crypto.randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);

  // 마지막 조각임을 뜻하는 0x02를 본문 끝에 붙인다
  const padded = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);   // 조각 크기
  header.writeUInt8(65, 20);        // 뒤따르는 공개 열쇠의 길이
  return Buffer.concat([header, asPub, body]);
}

async function sendPush(sub, payload) {
  const body = encryptPayload(payload, sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body
  });
  return r.status;
}

// ───────── 알림 문구 ─────────
const MSG = {
  ko: { title: (n) => n + '님에게서 연락이 와 있어요', body: '읽지 않은 이야기가 기다리고 있어요.' },
  en: { title: (n) => n + ' reached out to you', body: 'An unread moment is waiting.' },
  ja: { title: (n) => n + 'さんから連絡が来ています', body: '読んでいない物語が待っています。' }
};

// ───────── 본체 ─────────
exports.handler = async () => {
  const 결과 = { 대상: 0, 보냄: 0, 건너뜀: 0, 정리: 0, 실패: 0 };
  try {
    if (!process.env.VAPID_PRIVATE || !process.env.FIREBASE_SA_B64) {
      return { statusCode: 200, body: JSON.stringify({ skipped: '환경변수 미설정' }) };
    }
    const tok = await googleToken('https://www.googleapis.com/auth/datastore');
    const users = await pushUsers(tok);
    결과.대상 = users.length;
    const now = Date.now();

    for (const doc of users) {
      try {
        const f = doc.fields || {};
        const uid = doc.name.split('/').pop();

        // 이 유저의 현지 시각이 저녁 8시인가 (tzOffset은 분 단위, 브라우저가 준 값)
        const off = int(f, 'pushTz');            // 예: 한국이면 -540
        const localHour = new Date(now - off * 60000).getUTCHours();
        if (localHour !== SEND_HOUR) { 결과.건너뜀++; continue; }

        if (now - int(f, 'pushLastAt') < COOLDOWN_MS) { 결과.건너뜀++; continue; }

        const endpoint = str(f, 'pushEndpoint');
        const p256dh = str(f, 'pushKey');
        const auth = str(f, 'pushAuth');
        if (!endpoint || !p256dh || !auth) { 결과.건너뜀++; continue; }

        // 가장 오래 멈춰 있는 진행 중 인연을 찾는다
        const list = await fsGet('/players/' + uid + '/storyStates', tok);
        let 후보 = null;
        (list && list.documents || []).forEach(d => {
          const df = d.fields || {};
          if (df.archived && df.archived.booleanValue) return;
          if (str(df, 'collectionStatus') && str(df, 'collectionStatus') !== 'active') return;
          const last = int(df, 'lastTurnAt');
          if (!last || now - last < IDLE_MS) return;
          if (!후보 || last < 후보.last) 후보 = { last, id: d.name.split('/').pop() };
        });
        if (!후보) { 결과.건너뜀++; continue; }

        const lang = str(f, 'pushLang') || 'ko';
        const m = MSG[lang] || MSG.ko;
        const 이름 = str(f, 'pushName') || '';   // 브라우저가 저장해 둔 "가장 최근 인물 이름"
        const payload = JSON.stringify({
          title: 이름 ? m.title(이름) : m.body,
          body: m.body,
          storyId: 후보.id
        });

        const status = await sendPush({ endpoint, p256dh, auth }, payload);
        if (status === 404 || status === 410) {
          // 브라우저가 구독을 버린 경우 — 우리 쪽 기록도 정리한다
          await fetch(DOCS() + '/players/' + uid + '?updateMask.fieldPaths=pushOn',
            { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { pushOn: { booleanValue: false } } }) });
          결과.정리++;
        } else if (status >= 200 && status < 300) {
          await fetch(DOCS() + '/players/' + uid + '?updateMask.fieldPaths=pushLastAt',
            { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { pushLastAt: { integerValue: String(now) } } }) });
          결과.보냄++;
        } else {
          결과.실패++;
        }
      } catch (e) { 결과.실패++; }
    }
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: String(e && e.message || e).slice(0, 200) }) };
  }
  return { statusCode: 200, body: JSON.stringify(결과) };
};
