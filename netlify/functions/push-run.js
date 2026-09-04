// LUNIQUE 푸시 설정 확인 창구 — 71일차
// 정해진 시각에 도는 함수(push.js)는 주소로 직접 부를 수 없다(Netlify 정책, 403).
// 그래서 설정이 제대로 됐는지 눈으로 볼 수 있는 창구를 따로 둔다.
//
// **실제로 알림을 보내지 않는다.** "지금 보낸다면 몇 명에게 갈지"만 세어서 알려준다.
// 그래서 주소가 노출돼도 사고가 나지 않는다.
//
//   확인 주소: https://stately-pegasus-2b6e10.netlify.app/api/push-run
const { run } = require('./push.js');

exports.handler = async () => {
  const r = await run({ dryRun: true });
  return {
    statusCode: r.statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: r.body
  };
};
