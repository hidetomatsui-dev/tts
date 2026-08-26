const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
const MAX_PROMPT_LENGTH = 5000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'サーバーにGEMINI_API_KEYが設定されていません。' });
    return;
  }

  const { prompt, voice } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    res.status(400).json({ error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
    return;
  }
  if (!VOICES.includes(voice)) {
    res.status(400).json({ error: `voice must be one of: ${VOICES.join(', ')}` });
    return;
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };

  const MAX_ATTEMPTS = 3;
  let lastError;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        res.status(response.status).json({ error: data?.error?.message || 'Gemini API error' });
        return;
      }

      const hasAudio = data.candidates?.[0]?.content?.parts?.some(
        (p) => p.inlineData?.mimeType?.startsWith('audio/')
      );

      if (hasAudio) {
        res.status(200).json(data);
        return;
      }

      lastError = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown';
    }

    res.status(502).json({ error: `Gemini returned no audio after ${MAX_ATTEMPTS} attempts (reason: ${lastError})` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}
