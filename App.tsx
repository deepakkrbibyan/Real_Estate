
import React, { useState, useEffect, useRef } from 'react';
import { Role, Message, AppMode } from './types';
import { sendMessageStream } from './services/gemini';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio';

const STORAGE_KEY = 'krishana_chat_v1_history';

const KRISHANA_SYSTEM_INSTRUCTION = `
System Context: Agent "Krishana"
Role: Intelligent Voice Assistant.
Identity: You are the embodiment of professional serenity.
Brevity: You MUST be extremely brief. Limit every response to 1-2 concise sentences. Avoid lists or long explanations.
Tone: Calm, professional, and precise.
Formatting: Plain text only. No markdown.
`;

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<AppMode>('text');
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [currentTranscription, setCurrentTranscription] = useState<{user: string, model: string}>({user: '', model: ''});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptionsRef = useRef<{user: string, model: string}>({user: '', model: ''});

  // Load from Storage on Mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      } catch (e) {
        console.error("Failed to load history:", e);
      }
    }
  }, []);

  // Sync to Storage on Message Change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const clearHistory = () => {
    // Immediate state reset
    setMessages([]);
    setInputText('');
    setIsTyping(false);
    setErrorMessage(null);
    setCurrentTranscription({ user: '', model: '' });
    transcriptionsRef.current = { user: '', model: '' };
    
    // Wipe persistence
    localStorage.removeItem(STORAGE_KEY);
    
    // Terminate voice session if active
    if (isVoiceActive) {
      stopVoiceSession();
    }
  };

  const handleSendText = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isTyping) return;

    const query = inputText.trim();
    const userMsg: Message = {
      id: Date.now().toString(),
      role: Role.USER,
      text: query,
      timestamp: Date.now(),
    };

    const previousHistory = [...messages];
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsTyping(true);
    setErrorMessage(null);

    let modelText = '';
    const modelMsgId = (Date.now() + 1).toString();

    try {
      const stream = sendMessageStream(previousHistory, query);
      for await (const chunk of stream) {
        modelText += chunk;
        setMessages(prev => {
          const existing = prev.find(m => m.id === modelMsgId);
          if (existing) {
            return prev.map(m => m.id === modelMsgId ? { ...m, text: modelText } : m);
          } else {
            return [...prev, {
              id: modelMsgId,
              role: Role.MODEL,
              text: modelText,
              timestamp: Date.now()
            }];
          }
        });
      }
    } catch (error: any) {
      setErrorMessage("I'm sorry, I couldn't reach the service. Please try again.");
    } finally {
      setIsTyping(false);
    }
  };

  const startVoiceSession = async () => {
    setErrorMessage(null);
    try {
      if (!window.isSecureContext) throw new Error("Voice mode requires a secure HTTPS connection.");
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = inCtx;
      audioContextOutRef.current = outCtx;
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsVoiceActive(true);
            const source = inCtx.createMediaStreamSource(stream);
            const processor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;
            processor.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createPcmBlob(data) }));
            };
            source.connect(processor);
            processor.connect(inCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const b64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (b64) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioData(decode(b64), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.addEventListener('ended', () => activeSourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              // Fix: Access .current on activeSourcesRef before calling .add()
              activeSourcesRef.current.add(source);
            }
            if (msg.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
            if (msg.serverContent?.inputTranscription) {
              transcriptionsRef.current.user += msg.serverContent.inputTranscription.text;
              setCurrentTranscription(prev => ({ ...prev, user: transcriptionsRef.current.user }));
            }
            if (msg.serverContent?.outputTranscription) {
              transcriptionsRef.current.model += msg.serverContent.outputTranscription.text;
              setCurrentTranscription(prev => ({ ...prev, model: transcriptionsRef.current.model }));
            }
            if (msg.serverContent?.turnComplete) {
              const u = transcriptionsRef.current.user;
              const m = transcriptionsRef.current.model;
              if (u || m) {
                setMessages(prev => [
                  ...prev,
                  { id: Date.now().toString(), role: Role.USER, text: u || "(Voice Input)", timestamp: Date.now() },
                  { id: (Date.now()+1).toString(), role: Role.MODEL, text: m || "(Voice Response)", timestamp: Date.now() }
                ]);
              }
              transcriptionsRef.current = { user: '', model: '' };
              setCurrentTranscription({ user: '', model: '' });
            }
          },
          onerror: () => { 
            setErrorMessage("Voice session encountered an error."); 
            stopVoiceSession(); 
          },
          onclose: () => setIsVoiceActive(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: KRISHANA_SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      setErrorMessage(err.message || "Microphone access is required for voice mode.");
      setIsVoiceActive(false);
    }
  };

  const stopVoiceSession = () => {
    sessionPromiseRef.current?.then((s: any) => s.close());
    sessionPromiseRef.current = null;
    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
    audioContextInRef.current?.close();
    audioContextOutRef.current?.close();
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSourcesRef.current.clear();
    setIsVoiceActive(false);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans max-w-2xl mx-auto border-x border-slate-200">
      {/* Header */}
      <header className="p-4 bg-white border-b flex justify-between items-center glass-morphism sticky top-0 z-20 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-md">K</div>
          <div>
            <h1 className="text-md font-bold tracking-tight text-slate-700 leading-none">Krishana</h1>
            <span className="text-[10px] text-emerald-500 font-semibold uppercase tracking-wider">Online</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => { if (isVoiceActive) stopVoiceSession(); setMode(mode === 'text' ? 'voice' : 'text'); }}
            className="px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all border border-indigo-100 flex items-center gap-1.5"
          >
            {mode === 'text' ? (
              <><span className="w-2 h-2 rounded-full bg-indigo-400"></span> Voice Mode</>
            ) : (
              <><span className="w-2 h-2 rounded-full bg-slate-400"></span> Text Mode</>
            )}
          </button>
          <button 
            onClick={clearHistory} 
            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
            title="Clear Chat History"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </header>

      {/* Message List */}
      <main className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 scroll-smooth">
        {messages.length === 0 && !isTyping && (
          <div className="flex-1 flex flex-col items-center justify-center text-center opacity-40 px-8">
            <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-sm font-medium">History is clear.</p>
            <p className="text-xs italic mt-1">"Hello. How may I help you today?"</p>
          </div>
        )}
        
        {messages.map((msg) => (
          <div key={msg.id} className={`max-w-[85%] p-3.5 rounded-2xl shadow-sm transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${
            msg.role === Role.USER 
              ? 'bg-indigo-600 text-white self-end rounded-tr-none' 
              : 'bg-white text-slate-700 self-start rounded-tl-none border border-slate-100'
          }`}>
            <p className="leading-relaxed text-sm">{msg.text}</p>
          </div>
        ))}
        
        {isTyping && (
          <div className="self-start px-3.5 py-2 bg-white border border-slate-100 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1">
             <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce"></div>
             <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.2s]"></div>
             <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.4s]"></div>
          </div>
        )}
        <div ref={chatEndRef} />
      </main>

      {/* Controls */}
      <footer className="p-4 bg-white border-t glass-morphism z-20">
        {errorMessage && (
          <div className="mb-4 p-2.5 bg-red-50 text-red-600 text-[11px] rounded-lg border border-red-100 flex justify-between items-center animate-in slide-in-from-top-1">
            <span className="flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              {errorMessage}
            </span>
            <button onClick={() => setErrorMessage(null)} className="font-black text-xs hover:text-red-800">OK</button>
          </div>
        )}

        {mode === 'text' ? (
          <form onSubmit={handleSendText} className="flex gap-2.5 items-center">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Ask me anything..."
              className="flex-1 p-3 bg-slate-100 rounded-xl border-none focus:ring-2 focus:ring-indigo-500 transition-all outline-none text-sm placeholder:text-slate-400"
              disabled={isTyping}
            />
            <button 
              type="submit"
              disabled={!inputText.trim() || isTyping}
              className="w-11 h-11 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 transition-all flex items-center justify-center shadow-lg active:scale-95"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </form>
        ) : (
          <div className="flex flex-col items-center gap-3 py-1">
            <div className="h-5 flex items-center">
              {isVoiceActive ? (
                <div className="flex gap-1 items-center animate-pulse">
                  <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full"></div>
                  <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-widest">Krishana is listening</span>
                </div>
              ) : (
                <span className="text-slate-400 text-[10px] font-semibold uppercase tracking-wide">Tap the mic to start speaking</span>
              )}
            </div>
            <button
              onClick={isVoiceActive ? stopVoiceSession : startVoiceSession}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all transform hover:scale-110 active:scale-90 shadow-xl relative ${
                isVoiceActive ? 'bg-red-500 shadow-red-100 ring-4 ring-red-50' : 'bg-indigo-600 shadow-indigo-100'
              } text-white`}
            >
              {isVoiceActive ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48V208a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V48A16,16,0,0,1,56,32H200A16,16,0,0,1,216,48Z"></path></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="currentColor" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0ZM208,128a8,8,0,0,1-16,0,64,64,0,0,0-128,0,8,8,0,0,1-16,0,80.11,80.11,0,0,1,72-79.6V32a8,8,0,0,1,16,0V48.4A80.11,80.11,0,0,1,208,128Z"></path></svg>
              )}
            </button>
            <div className="h-4 text-[11px] text-slate-400 italic truncate w-full text-center px-6">
              {currentTranscription.user || ""}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
};

export default App;
