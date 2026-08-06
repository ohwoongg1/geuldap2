const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// CORS 허용 (geuldap.co.kr에서 호출 가능하도록)
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

exports.evaluateWriting = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: "asia-northeast3" },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용됩니다" }); return; }

    try {
      const { prompt, image, images } = req.body || {};
      if (!prompt) {
        console.error("prompt 누락. req.body:", JSON.stringify(req.body));
        res.status(400).json({ error: "prompt가 필요합니다" });
        return;
      }

      let content = prompt;
      if (Array.isArray(images) && images.length) {
        content = [
          ...images.map(img => ({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data } })),
          { type: "text", text: prompt },
        ];
      } else if (image) {
        content = [
          { type: "image", source: { type: "base64", media_type: image.mediaType || "image/jpeg", data: image.data } },
          { type: "text", text: prompt },
        ];
      }

      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 8192,
          messages: [{ role: "user", content }],
        }),
      });

      const rawText = await apiRes.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.error("Anthropic 응답이 JSON이 아님. status:", apiRes.status, "body:", rawText);
        res.status(500).json({ error: `Anthropic 응답 파싱 실패 (status ${apiRes.status})` });
        return;
      }

      if (!apiRes.ok || data.error) {
        console.error("Anthropic API 오류. status:", apiRes.status, "data:", JSON.stringify(data));
        res.status(500).json({ error: (data.error && data.error.message) || `Anthropic API 오류 (status ${apiRes.status})` });
        return;
      }

      const textBlock = (data.content || []).find(c => c.type === 'text');
      if (!textBlock || !textBlock.text) {
        console.error("텍스트 블록을 찾을 수 없음:", JSON.stringify(data));
        res.status(500).json({ error: "AI 응답에서 텍스트를 찾을 수 없습니다" });
        return;
      }
      if (data.stop_reason === 'max_tokens') {
        console.error("응답이 max_tokens로 잘림. output_tokens:", data.usage && data.usage.output_tokens);
      }

      res.status(200).json({ text: textBlock.text });
    } catch (e) {
      console.error("evaluateWriting 예외:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

// ============================================
// 아래부터 Gemini 함수 (글 평가 / 성장 리포트 / 퀴즈 채점 비용 절감용)
// 서버가 일시적으로 붐빌 때(고수요 오류)를 대비해, 자동 재시도 + 가벼운 모델로 자동 전환하는 안전장치 포함
// ============================================

function extractGeminiText(data) {
  if (
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0]
  ) {
    return data.candidates[0].content.parts[0].text;
  }
  return null;
}

function isOverloadedError(status, data) {
  if (status === 503 || status === 429) return true;
  const msg = (data && data.error && data.error.message) ? data.error.message.toLowerCase() : '';
  return msg.indexOf('overloaded') !== -1 || msg.indexOf('high demand') !== -1 || msg.indexOf('unavailable') !== -1;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 시도 순서: gemini-3.5-flash 3번(1.5초, 3초 간격 재시도) → 그래도 안 되면 gemini-3.5-flash-lite로 1번 더
const GEMINI_ATTEMPTS = [
  { model: 'gemini-3.5-flash', delayBefore: 0 },
  { model: 'gemini-3.5-flash', delayBefore: 1500 },
  { model: 'gemini-3.5-flash', delayBefore: 3000 },
  { model: 'gemini-3.5-flash-lite', delayBefore: 1500 },
];

// parts: Gemini API의 contents[0].parts 배열 (텍스트만이면 [{text: prompt}], 이미지 포함이면 이미지들+텍스트)
async function callGeminiWithFallback(parts) {
  let lastErrorMessage = 'Gemini 오류';
  for (let i = 0; i < GEMINI_ATTEMPTS.length; i++) {
    const attempt = GEMINI_ATTEMPTS[i];
    if (attempt.delayBefore) await sleep(attempt.delayBefore);

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + attempt.model + ":generateContent?key=" + GEMINI_API_KEY.value();
    let geminiRes, rawText, data;
    try {
      geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 16384 }
        })
      });
      rawText = await geminiRes.text();
      data = JSON.parse(rawText);
    } catch (e) {
      lastErrorMessage = 'Gemini 응답 처리 오류: ' + e.message;
      continue;
    }

    if (!geminiRes.ok || data.error) {
      lastErrorMessage = (data.error && data.error.message) || ('Gemini API 오류 (status ' + geminiRes.status + ')');
      console.error("Gemini 시도 " + (i+1) + "/" + GEMINI_ATTEMPTS.length + " (" + attempt.model + ") 실패:", lastErrorMessage);
      if (isOverloadedError(geminiRes.status, data)) continue; // 다음 시도로
      throw new Error(lastErrorMessage); // 수요 초과가 아닌 다른 오류는 즉시 중단
    }

    const text = extractGeminiText(data);
    if (!text) {
      lastErrorMessage = 'Gemini 응답에서 텍스트를 찾을 수 없습니다';
      continue;
    }
    return text; // 성공
  }
  throw new Error(lastErrorMessage + ' (여러 번 재시도했지만 실패했습니다. 잠시 후 다시 시도해주세요.)');
}

exports.evaluateWithGemini = onRequest(
  { secrets: [GEMINI_API_KEY], region: "asia-northeast3", timeoutSeconds: 120 },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용됩니다" }); return; }

    try {
      const { prompt } = req.body || {};
      if (!prompt) {
        res.status(400).json({ error: "prompt가 필요합니다" });
        return;
      }
      const text = await callGeminiWithFallback([{ text: prompt }]);
      res.status(200).json({ text });
    } catch (e) {
      console.error("evaluateWithGemini 예외:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

exports.evaluateQuizWithGemini = onRequest(
  { secrets: [GEMINI_API_KEY], region: "asia-northeast3", timeoutSeconds: 120 },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용됩니다" }); return; }

    try {
      const { prompt, images } = req.body || {};
      if (!prompt) {
        res.status(400).json({ error: "prompt가 필요합니다" });
        return;
      }
      const parts = (images || []).map(img => ({
        inline_data: { mime_type: img.mediaType || "image/jpeg", data: img.data }
      }));
      parts.push({ text: prompt });
      const text = await callGeminiWithFallback(parts);
      res.status(200).json({ text });
    } catch (e) {
      console.error("evaluateQuizWithGemini 예외:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

// ============================================
// 블로그 자동생성용 추천 이미지 생성
// (블로그 글 텍스트 자체는 새 함수 없이 evaluateWithGemini를 그대로 재사용합니다.
//  이미지는 응답 형식이 완전히 달라서 - 텍스트가 아니라 base64 이미지가 옴 - 별도 함수로 뺐습니다)
// ============================================
const BLOG_IMAGE_MODEL = "gemini-2.5-flash-image";

// 실사(포토리얼) 아동 얼굴 생성을 막기 위한 안전장치 문구.
// 사용자가 보낸 프롬프트 뒤에 항상 덧붙여서, 요청 내용과 무관하게 항상 강제 적용되게 한다.
const BLOG_IMAGE_SAFETY_SUFFIX =
  "\n\n[스타일 제약 — 반드시 지킬 것]\n" +
  "- 실제 사진처럼 보이는 사실적인(포토리얼) 인물, 특히 아동 얼굴을 그리지 않는다.\n" +
  "- 사람이 필요하면 따뜻한 색감의 손그림/일러스트 스타일로만 그리고, 특정 인물을 연상시키지 않는 일반적인 캐릭터로 그린다.\n" +
  "- 텍스트나 글자는 이미지 안에 넣지 않는다.\n" +
  "- 네이버 블로그 본문에 어울리는 밝고 따뜻한 분위기로 그린다.";

exports.generateBlogImage = onRequest(
  { secrets: [GEMINI_API_KEY], region: "asia-northeast3", timeoutSeconds: 60 },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용됩니다" }); return; }

    try {
      const { prompt } = req.body || {};
      if (!prompt) {
        res.status(400).json({ error: "prompt가 필요합니다" });
        return;
      }

      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + BLOG_IMAGE_MODEL + ":generateContent?key=" + GEMINI_API_KEY.value();
      const apiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt + BLOG_IMAGE_SAFETY_SUFFIX }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
        })
      });

      const rawText = await apiRes.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.error("이미지 생성 응답이 JSON이 아님. status:", apiRes.status, "body:", rawText);
        res.status(500).json({ error: `이미지 생성 응답 파싱 실패 (status ${apiRes.status})` });
        return;
      }

      if (!apiRes.ok || data.error) {
        console.error("이미지 생성 API 오류. status:", apiRes.status, "data:", JSON.stringify(data));
        res.status(500).json({ error: (data.error && data.error.message) || `이미지 생성 API 오류 (status ${apiRes.status})` });
        return;
      }

      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
      if (!imagePart) {
        // 안전 필터에 걸려 이미지 없이 텍스트만 돌아오는 경우가 있음 (예: 부적절한 요청으로 판단된 경우)
        const textPart = parts.find(p => p.text);
        console.error("이미지 파트를 찾을 수 없음. 응답:", JSON.stringify(data));
        res.status(500).json({ error: textPart ? ("이미지를 만들지 못했어요: " + textPart.text) : "이미지 생성에 실패했습니다. 프롬프트를 조금 바꿔서 다시 시도해주세요." });
        return;
      }

      res.status(200).json({
        imageBase64: imagePart.inlineData.data,
        mimeType: imagePart.inlineData.mimeType || "image/png"
      });
    } catch (e) {
      console.error("generateBlogImage 예외:", e);
      res.status(500).json({ error: e.message });
    }
  }
);
