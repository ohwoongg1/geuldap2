// ============================================
// geuldap-sever/functions/index.js 맨 아래에 추가할 코드
// ============================================

const { defineSecret } = require("firebase-functions/params");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// 글 평가 / 성장 리포트 (텍스트만)
exports.evaluateWithGemini = onRequest(
  { region: "asia-northeast3", secrets: [GEMINI_API_KEY], cors: true },
  async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) {
        res.status(400).json({ error: "prompt가 필요합니다." });
        return;
      }

      const apiKey = GEMINI_API_KEY.value();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 16384 }
        })
      });

      const data = await geminiRes.json();
      if (!geminiRes.ok || data.error) {
        res.status(500).json({ error: data.error?.message || "Gemini 오류" });
        return;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        res.status(500).json({ error: "Gemini 응답이 비어 있습니다." });
        return;
      }

      res.json({ text });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// 퀴즈 채점 (이미지 포함)
exports.evaluateQuizWithGemini = onRequest(
  { region: "asia-northeast3", secrets: [GEMINI_API_KEY], cors: true },
  async (req, res) => {
    try {
      const { prompt, images } = req.body;
      if (!prompt) {
        res.status(400).json({ error: "prompt가 필요합니다." });
        return;
      }

      const apiKey = GEMINI_API_KEY.value();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const parts = (images || []).map(img => ({
        inline_data: { mime_type: img.mediaType || "image/jpeg", data: img.data }
      }));
      parts.push({ text: prompt });

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 16384 }
        })
      });

      const data = await geminiRes.json();
      if (!geminiRes.ok || data.error) {
        res.status(500).json({ error: data.error?.message || "Gemini 오류" });
        return;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        res.status(500).json({ error: "Gemini 응답이 비어 있습니다." });
        return;
      }

      res.json({ text });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);
