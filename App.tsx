
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Square, Trash2, FileText, AlertCircle, Music, FileJson, Clock, RefreshCw, Zap, AlignLeft, Monitor, Smartphone, Volume2 } from 'lucide-react';
import { GoogleGenAI, Modality } from '@google/genai';
import { downloadTextFile, downloadAudioFile, formatDuration } from './utils/fileUtils';
import Visualizer from './components/Visualizer';
import { AudioMetadata } from './types';

// 오디오 인코딩 유틸리티 (PCM 16-bit to Base64)
const encode = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioData, setAudioData] = useState<AudioMetadata | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [transcribedText, setTranscribedText] = useState<string>('');
  const [sourceMode, setSourceMode] = useState<'mic' | 'system'>('mic');
  const [isMobile, setIsMobile] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<any>(null);
  const textEndRef = useRef<HTMLDivElement>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  useEffect(() => {
    setIsMobile(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
    return () => {
        stopRecording();
    };
  }, []);

  // 텍스트 업데이트 시 하단으로 자동 스크롤
  useEffect(() => {
    if (textEndRef.current) {
      textEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcribedText]);

  const requestWakeLock = async () => {
    if ('wakeLock' in navigator && (navigator as any).wakeLock) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch (err) {
        console.warn("Wake Lock failed", err);
      }
    }
  };

  const stopRecording = useCallback(() => {
    if (isRecording) {
      if (mediaRecorderRef.current) {
          mediaRecorderRef.current.stop();
      }
      
      if (audioCtxRef.current) {
          audioCtxRef.current.close();
          audioCtxRef.current = null;
      }
      
      setIsRecording(false);
      if (wakeLockRef.current) {
          wakeLockRef.current.release();
          wakeLockRef.current = null;
      }
      if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
      }
      
      // 세션은 명시적으로 닫지 않아도 Context가 닫히면 끊기지만 관리를 위해 초기화
      sessionPromiseRef.current = null;
    }
  }, [isRecording]);

  const startRecording = async () => {
    try {
      let captureStream: MediaStream;
      
      if (sourceMode === 'system') {
        // PC에서 유튜브 등 시스템 오디오 캡처
        captureStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1 }, // 브라우저 제약상 비디오 트랙 필요
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        });
      } else {
        // 마이크 캡처 (스마트폰/PC)
        captureStream = await navigator.mediaDevices.getUserMedia({
          audio: { 
            echoCancellation: true, 
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      }
      
      setStream(captureStream);
      setTranscribedText('');
      setRecordingTime(0);

      // 1. Gemini Live API 연결
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO], // 규칙 준수
          inputAudioTranscription: {}, // 실시간 입력 받아쓰기 활성화
          systemInstruction: "너는 오디오 실시간 받아쓰기 전문가야. 입력되는 모든 음성(유튜브 영상 소리, 대화 등)을 정확하게 한국어로 텍스트화해줘. 불필요한 추임새는 생략하고 가독성 좋게 적어줘."
        },
        callbacks: {
          onmessage: async (message) => {
            // 입력 오디오에 대한 받아쓰기 결과 추출
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setTranscribedText(prev => prev + text);
            }
          },
          onerror: (e) => console.error("Gemini Live Error:", e),
          onclose: () => console.log("Gemini Live Session Closed")
        }
      });
      sessionPromiseRef.current = sessionPromise;

      // 2. 오디오 프로세싱 (PCM 16k 스트리밍)
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(captureStream);
      const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          int16[i] = inputData[i] * 32768; // Float32 to Int16
        }
        const base64Data = encode(new Uint8Array(int16.buffer));
        
        sessionPromiseRef.current?.then(session => {
          session.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        });
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioCtx.destination);

      // 3. 파일 저장을 위한 녹음
      const mediaRecorder = new MediaRecorder(captureStream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        setAudioData({ blob, url, duration: recordingTime });
        downloadAudioFile(blob, `필통녹음_${sourceMode === 'system' ? '유튜브' : '마이크'}_${formatDuration(recordingTime)}.mp3`);
        captureStream.getTracks().forEach(t => t.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      await requestWakeLock();
      
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("녹음 시작 실패:", err);
      alert("권한이 거부되었거나 지원되지 않는 브라우저입니다.");
    }
  };

  const handleDownloadText = () => {
    if (!transcribedText) return;
    downloadTextFile(transcribedText.trim(), `필통텍스트_${formatDuration(recordingTime)}.txt`);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center p-4 sm:p-6 md:p-10">
      <header className="w-full max-w-2xl mt-2 mb-10 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-600/5 px-4 py-2 rounded-full border border-blue-100 mb-5">
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-blue-600'}`}></div>
          <span className="text-[10px] font-black text-blue-700 uppercase tracking-[0.2em]">Real-time Hybrid Transcriber</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-black text-slate-900 tracking-tighter">
          필통 <span className="text-blue-600">녹음기 PRO</span>
        </h1>
        <p className="text-slate-400 font-bold text-sm mt-3 uppercase tracking-tighter">유튜브 소리를 디지털로 직접 텍스트 변환</p>
      </header>

      <main className="w-full max-w-3xl bg-white rounded-[56px] shadow-2xl shadow-blue-900/10 border border-white overflow-hidden flex flex-col relative">
        {/* 소스 선택 탭 */}
        <div className="p-5 flex gap-3 bg-slate-50/80 border-b border-slate-100">
          <button 
            disabled={isRecording}
            onClick={() => setSourceMode('mic')}
            className={`flex-1 py-4 rounded-[28px] flex items-center justify-center gap-3 font-black text-xs transition-all ${sourceMode === 'mic' ? 'bg-white shadow-xl text-blue-600 border border-blue-50' : 'text-slate-400 hover:text-slate-600 opacity-60'}`}
          >
            <Smartphone className="w-4 h-4" />
            마이크 / 스마트폰
          </button>
          {!isMobile && (
            <button 
              disabled={isRecording}
              onClick={() => setSourceMode('system')}
              className={`flex-1 py-4 rounded-[28px] flex items-center justify-center gap-3 font-black text-xs transition-all ${sourceMode === 'system' ? 'bg-white shadow-xl text-blue-600 border border-blue-50' : 'text-slate-400 hover:text-slate-600 opacity-60'}`}
            >
              <Monitor className="w-4 h-4" />
              유튜브 / 시스템 오디오
            </button>
          )}
        </div>

        <div className="p-8 md:p-14 flex flex-col items-center">
          <div className="relative mb-12">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`w-36 h-36 md:w-44 md:h-44 rounded-full flex items-center justify-center transition-all duration-700 transform active:scale-95 shadow-2xl ${
                isRecording 
                  ? 'bg-red-500 shadow-red-200 ring-[20px] ring-red-50' 
                  : 'bg-blue-600 shadow-blue-200 ring-[20px] ring-blue-50 hover:bg-blue-700'
              }`}
            >
              {isRecording ? <Square className="w-14 h-14 text-white fill-current" /> : <Mic className="w-14 h-14 text-white" />}
              {isRecording && (
                <div className="absolute inset-0 rounded-full border-4 border-white/20 animate-ping"></div>
              )}
            </button>
          </div>

          <div className="text-center w-full mb-12">
            <div className={`text-7xl md:text-9xl font-mono font-black tracking-tighter mb-6 ${isRecording ? 'text-red-500' : 'text-slate-900'}`}>
              {formatDuration(recordingTime)}
            </div>
            
            {isRecording ? (
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-2 bg-blue-50 px-4 py-2 rounded-full text-blue-600 font-black text-xs uppercase animate-pulse">
                  <Zap className="w-4 h-4 fill-current" />
                  <span>Gemini Native Audio 엔진 실시간 분석 중</span>
                </div>
                <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest mt-1">
                  {sourceMode === 'system' ? '유튜브 디지털 스트림 캡처 중' : '주변 소리 및 마이크 캡처 중'}
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3 text-slate-300 text-xs font-bold uppercase tracking-[0.2em]">
                <Clock className="w-4 h-4" />
                <span>최대 1시간 무중단 텍스트 변환</span>
              </div>
            )}
          </div>

          <div className="w-full px-4 md:px-12">
            <Visualizer stream={stream} isRecording={isRecording} />
          </div>
        </div>

        {/* 텍스트 뷰어 섹션 */}
        <div className="px-6 pb-6 md:px-12 md:pb-12">
          <div className={`bg-slate-50 rounded-[40px] p-8 md:p-10 border transition-all duration-500 ${isRecording ? 'border-blue-200 shadow-2xl shadow-blue-100 ring-4 ring-blue-50' : 'border-slate-100 shadow-inner'}`}>
            <div className="flex items-center justify-between mb-6 border-b border-slate-200 pb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-600 rounded-xl">
                    <AlignLeft className="w-4 h-4 text-white" />
                </div>
                <span className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em]">Live Feed</span>
              </div>
              {isRecording && (
                <div className="flex items-center gap-2">
                    <Volume2 className="w-3 h-3 text-blue-400 animate-bounce" />
                    <RefreshCw className="w-3 h-3 text-blue-400 animate-spin" />
                </div>
              )}
            </div>

            <div className="h-64 md:h-80 overflow-y-auto text-slate-800 text-lg md:text-xl leading-[1.6] font-medium scrollbar-hide">
              {transcribedText ? (
                <div className="whitespace-pre-wrap animate-in fade-in duration-700">
                  {transcribedText}
                  <div ref={textEndRef} className="h-4" />
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-200 italic">
                  <FileText className="w-16 h-16 mb-4 opacity-10" />
                  <p className="text-sm font-bold uppercase tracking-widest opacity-50">음성을 감지하면 즉시 텍스트로 변환됩니다</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-5">
            <button
              onClick={handleDownloadText}
              disabled={!transcribedText || isRecording}
              className={`w-full py-7 rounded-[32px] font-black flex items-center justify-center gap-4 transition-all text-xl md:text-2xl shadow-2xl ${
                !transcribedText || isRecording
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
                  : 'bg-amber-400 text-white hover:bg-amber-500 shadow-amber-200 active:scale-95'
              }`}
            >
              <FileJson className="w-8 h-8" />
              전체 받아쓰기 텍스트 저장
            </button>
            <div className="bg-slate-50 p-5 rounded-3xl border border-slate-100">
                <p className="text-[11px] text-slate-400 font-bold text-center leading-relaxed uppercase tracking-tighter">
                  팁: PC에서 유튜브를 틀고 <span className="text-blue-500">'시스템 오디오'</span> 모드로 시작한 뒤 해당 탭을 공유하면 마이크 없이 깨끗하게 텍스트가 추출됩니다.
                </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-14 text-slate-300 text-[10px] font-black uppercase tracking-[0.5em] text-center">
        PILTONG PRO • POWERED BY GEMINI 2.5 NATIVE AUDIO
      </footer>
    </div>
  );
};

export default App;
