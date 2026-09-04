// LUNIQUE 서비스 워커 (68일차) — 홈 화면 설치(PWA)용 최소 구성.
// 정책: 화면(HTML)을 여는 요청만 다룬다. 항상 네트워크를 먼저 쓰고,
// 네트워크가 끊겼을 때만 마지막으로 받아둔 사본을 보여준다.
// 대화 API·Firebase·이미지 등 나머지 요청에는 일절 손대지 않는다(구버전이 남는 사고 방지).
const CACHE = 'lunique-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 71일차: 푸시 알림 수신. 서버가 보낸 문구를 그대로 띄운다.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = d.title || 'LUNIQUE';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png',
    tag: 'lunique-nudge',        // 여러 개 쌓이지 않게 늘 같은 자리에 덮어쓴다
    renotify: true,
    data: { storyId: d.storyId || '' }
  }));
});

// 알림을 누르면 그 인연의 대화로 바로 들어간다. 이미 열린 창이 있으면 그 창을 쓴다.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = (e.notification.data && e.notification.data.storyId) || '';
  const url = id ? ('/?story=' + encodeURIComponent(id)) : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0) {
          c.focus();
          if ('navigate' in c) c.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate') return; // 화면을 여는 요청이 아니면 브라우저 기본 동작 그대로
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
