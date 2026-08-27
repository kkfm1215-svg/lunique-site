// 이 파일은 Netlify의 "Edge Function"으로 실행된다 (브라우저가 아니라 Netlify 서버에서 실행됨).
// 진짜 Gemini API 키는 여기서만 사용되고, 브라우저(app.html)로는 절대 전달되지 않는다.
// 진짜 키 값은 코드에 직접 적지 않고, Netlify 사이트 설정의 "환경 변수(Environment variables)"에
// GEMINI_API_KEY 라는 이름으로 등록해서 사용한다.

export default async (request, context) => {
  const apiKey = Deno.env.get("GEMINI_API_KEY");

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "서버에 GEMINI_API_KEY 환경 변수가 설정되어 있지 않아요." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST 요청만 허용돼요." }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const requestBody = await request.text();

  // 68일차: 모델 비교 테스트용. 주소 뒤에 ?model=2.5 를 붙이면 더 싼 모델로 호출한다.
  // 아무것도 안 붙이면 지금까지와 똑같이 3.5로 동작한다(기존 동작 그대로).
  // 아래 목록에 없는 값은 전부 무시되므로, 남이 임의의 모델을 쓰게 만들 수는 없다.
  const ALLOWED = {
    "3.5": "gemini-3.5-flash-lite",   // 현재 사용 중 (입력 $0.30 / 출력 $2.50)
    "3.1": "gemini-3.1-flash-lite",   // 더 저렴 (입력 $0.25 / 출력 $1.50) — 약 24% 절감
    "3.6": "gemini-3.6-flash"         // 더 비싸고 더 똑똑함 (입력 $0.75 / 출력 $3.75) — 품질 비교용
  };
  const asked = new URL(request.url).searchParams.get("model") || "3.5";
  const model = ALLOWED[asked] || ALLOWED["3.5"];

  const upstream = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: requestBody,
    }
  );

  // 구글 쪽 응답을 그대로(스트리밍 상태 그대로) 우리 사이트 방문자에게 전달한다.
  // 이렇게 해야 지금처럼 대화가 실시간으로 한 글자씩 나오는 느낌이 그대로 유지된다.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
};

export const config = { path: "/api/chat" };
