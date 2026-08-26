import React, { useState, useRef, useEffect } from 'react';
import { Mic, Download, Play, Square, Settings2, MessageSquare, Wand2, Volume2, User, Users } from 'lucide-react';

const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
const STYLES = ['指定なし', '明るい', '落ち着いた', 'エネルギッシュな', '悲しい', '怒った'];
const PACES = ['指定なし', 'ゆっくり', '普通', '速く'];

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function pcmToWav(pcmData, sampleRate) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcmData.length; i++, offset += 2) {
    view.setInt16(offset, pcmData[i], true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function pcmToMp3(pcmData, sampleRate) {
  const numChannels = 1;
  const kbps = 128;
  const mp3encoder = new window.lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
  const mp3Data = [];
  const sampleBlockSize = 1152;

  for (let i = 0; i < pcmData.length; i += sampleBlockSize) {
    const sampleChunk = pcmData.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) mp3Data.push(mp3buf);
  }

  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) mp3Data.push(mp3buf);

  return new Blob(mp3Data, { type: 'audio/mp3' });
}

export default function App() {
  const [activeTab, setActiveTab] = useState('single');
  const [voice, setVoice] = useState('Kore');
  const [style, setStyle] = useState('指定なし');
  const [pace, setPace] = useState('指定なし');
  const [scene, setScene] = useState('');
  const [context, setContext] = useState('');
  const [text, setText] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioFormat, setAudioFormat] = useState('wav');
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [mp3Ready, setMp3Ready] = useState(!!window.lamejs);

  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);

  useEffect(() => {
    if (window.lamejs) {
      setMp3Ready(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    script.async = true;
    script.onload = () => setMp3Ready(true);
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const generateAudio = async (isPreview = false) => {
    if (!text.trim()) return;

    setIsGenerating(true);
    setIsPlaying(false);
    setError(null);

    const promptText = isPreview ? text.substring(0, 50) : text;

    const instructions = [];
    if (style !== '指定なし') instructions.push(`${style}トーンで`);
    if (pace !== '指定なし') instructions.push(`${pace}ペースで`);
    if (scene) instructions.push(`場面: ${scene}`);
    if (context) instructions.push(`背景/感情: ${context}`);

    const modifiedPrompt = instructions.length > 0
      ? `以下を${instructions.join('、')}読んでください:\n\n${promptText}`
      : promptText;

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: modifiedPrompt, voice }),
      });

      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) detail = errBody.error;
        } catch {
          // ignore parse failure, use status text
        }
        throw new Error(`APIリクエストに失敗しました: ${detail}`);
      }

      const result = await response.json();

      let audioData = null;
      let mimeType = null;
      const candidate = result.candidates?.[0];
      const audioPart = candidate?.content?.parts?.find(
        (p) => p.inlineData?.mimeType?.startsWith('audio/')
      );
      if (audioPart) {
        audioData = audioPart.inlineData.data;
        mimeType = audioPart.inlineData.mimeType;
      }

      if (!audioData || !mimeType) {
        console.error('Unexpected API response:', result);
        const reason = candidate?.finishReason || result.promptFeedback?.blockReason;
        const detail = reason ? `reason: ${reason}` : JSON.stringify(result).slice(0, 300);
        throw new Error(`音声データの取得に失敗しました（想定外のAPI応答）。${detail}`);
      }

      let sampleRate = 24000;
      const rateMatch = mimeType.match(/rate=(\d+)/);
      if (rateMatch) sampleRate = parseInt(rateMatch[1], 10);

      const pcmBuffer = base64ToArrayBuffer(audioData);
      const pcm16 = new Int16Array(pcmBuffer);

      const useMp3 = !!window.lamejs;
      const audioBlob = useMp3 ? pcmToMp3(pcm16, sampleRate) : pcmToWav(pcm16, sampleRate);
      const url = URL.createObjectURL(audioBlob);

      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = url;

      setAudioUrl(url);
      setAudioFormat(useMp3 ? 'mp3' : 'wav');
    } catch (err) {
      console.error(err);
      setError(err.message || '音声の生成に失敗しました。');
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleAudioEnded = () => setIsPlaying(false);

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `tts-studio-${Date.now()}.${audioFormat}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-2">
          <div className="bg-blue-600 p-2 rounded-lg text-white">
            <Mic size={24} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            TTS Studio <span className="text-sm font-normal text-gray-400 ml-2">(高品質AI音声版)</span>
          </h1>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col md:flex-row gap-6">
        <div className="w-full md:w-1/3 flex flex-col gap-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-2 flex">
            <button
              className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-colors ${activeTab === 'single' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
              onClick={() => setActiveTab('single')}
            >
              <User size={16} /> シングルスピーカー
            </button>
            <button
              className="flex-1 py-2 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-medium text-gray-300 cursor-not-allowed"
              disabled
            >
              <Users size={16} /> マルチスピーカー (準備中)
            </button>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4 text-gray-700 font-medium">
              <Settings2 size={18} className="text-blue-500" />
              <h2>音声設定</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">スピーカー (AI音声)</label>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow bg-gray-50"
                >
                  {VOICES.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-2">※ Geminiの高音質モデルを使用して生成されます。</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4 text-gray-700 font-medium">
              <MessageSquare size={18} className="text-blue-500" />
              <h2>コンテキスト設定</h2>
            </div>

            <div className="space-y-5">
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-600 mb-1">Style (スタイル)</label>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-gray-50"
                  >
                    {STYLES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-600 mb-1">Pace (ペース・話速)</label>
                  <select
                    value={pace}
                    onChange={(e) => setPace(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-gray-50"
                  >
                    {PACES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Scene (場面設定)</label>
                <textarea
                  value={scene}
                  onChange={(e) => setScene(e.target.value)}
                  placeholder="例: 静かで洗練されたオフィスの空間。"
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-gray-50 min-h-[80px] resize-y"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Sample Context (背景・感情のトーン)</label>
                <textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="例: 落ち着いていて、無駄がない。共感的で安心感を与えるトーン。"
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-gray-50 min-h-[80px] resize-y"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="w-full md:w-2/3 flex flex-col">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-full">
            <div className="p-5 border-b border-gray-100 flex items-center gap-2">
              <Wand2 size={18} className="text-blue-500" />
              <h2 className="font-medium text-gray-700">読み上げるテキスト</h2>
            </div>

            <div className="flex-1 p-5">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full h-full min-h-[300px] border border-gray-300 rounded-xl p-4 text-gray-800 text-base leading-relaxed focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-gray-50 resize-y"
                placeholder="ここに読み上げるテキストを入力してください..."
              />
            </div>

            <div className="p-5 border-t border-gray-100 bg-gray-50/50 rounded-b-xl flex flex-col gap-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm border border-red-100">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => generateAudio(false)}
                  disabled={isGenerating || !text.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-6 rounded-full flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {isGenerating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      生成中...
                    </>
                  ) : (
                    <>
                      <Wand2 size={18} />
                      音声を生成する
                    </>
                  )}
                </button>

                <button
                  onClick={() => generateAudio(true)}
                  disabled={isGenerating || !text.trim()}
                  className="bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium py-2.5 px-6 rounded-full flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play size={18} />
                  プレビュー (冒頭)
                </button>

                {!mp3Ready && (
                  <span className="text-xs text-gray-400">MP3変換ライブラリを読み込み中...(未ロード時はWAVで出力)</span>
                )}
              </div>

              {audioUrl && (
                <div className="mt-4 bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={handlePlayPause}
                      className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center hover:bg-blue-200 transition-colors"
                    >
                      {isPlaying ? <Square size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-1" />}
                    </button>
                    <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <Volume2 size={16} className="text-gray-400" />
                      {voice}の音声が生成されました
                    </div>
                  </div>

                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-blue-600 transition-colors px-3 py-2 rounded-lg hover:bg-gray-100"
                  >
                    <Download size={16} />
                    ダウンロード (.{audioFormat})
                  </button>

                  <audio
                    ref={audioRef}
                    src={audioUrl}
                    onEnded={handleAudioEnded}
                    className="hidden"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
