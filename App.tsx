
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Role, Message, AppMode, ChatSession, Property, CustomerLead, AppView } from './types';
import { sendMessageStream } from './services/gemini';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, decodeAudioData, createPcmBlob, encode } from './utils/audio';
import { db } from './services/db';

const KRISHANA_SYSTEM_INSTRUCTION = `
System Context: Agent "Krishana"
Role: Global Luxury Real Estate Advisor.
Identity: You are the embodiment of professional serenity.
Brevity: Limit every response to 1-2 concise sentences.
Knowledge: You help clients find exclusive properties in Noida, Delhi, Gurugram, and Faridabad. 
Formatting: Plain text only.
`;

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('chat');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [dbSetupRequired, setDbSetupRequired] = useState(false);
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [leadForm, setLeadForm] = useState<CustomerLead>({
    full_name: '', email: '', preferred_contact: 'email'
  });

  // Filter States
  const [cityFilter, setCityFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Audio Refs
  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  // Transcription Buffers
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  useEffect(() => {
    const init = async () => {
      try {
        await db.init();
        const [loadedSessions, loadedProperties] = await Promise.all([
          db.getAllSessions(),
          db.getProperties()
        ]);
        setSessions(loadedSessions);
        setProperties(loadedProperties);
        if (loadedSessions.length > 0) selectSession(loadedSessions[0].id);
        else createNewSession();
      } catch (err: any) {
        console.error("Init Error:", err.message);
        if (err.message === "TABLES_NOT_FOUND") {
          setDbSetupRequired(true);
        } else {
          setErrorMessage("Cloud connection failed. Please check your Supabase setup.");
        }
      }
    };
    init();
    return () => stopVoiceSession();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, view, isVoiceActive]);

  const cities = useMemo(() => {
    const list = Array.from(new Set(properties.map(p => p.city)));
    return ['All', ...list.sort()];
  }, [properties]);

  const filteredProperties = useMemo(() => {
    return properties.filter(p => {
      const matchesCity = cityFilter === 'All' || p.city === cityFilter;
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            p.description.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCity && matchesSearch;
    });
  }, [properties, cityFilter, searchQuery]);

  const createNewSession = async () => {
    const newId = crypto.randomUUID();
    const newSession = { id: newId, name: `Strategic Consultation`, messages: [], updatedAt: Date.now() };
    try {
      await db.saveSession(newSession);
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newId);
      setMessages([]);
      setIsSidebarOpen(false);
      setView('chat');
    } catch (err) {
      setErrorMessage("Could not create cloud session.");
    }
  };

  const selectSession = async (id: string) => {
    try {
      const s = await db.getSession(id);
      if (s) { 
        setCurrentSessionId(id); 
        setMessages(s.messages); 
        setView('chat'); 
        setIsSidebarOpen(false); 
      }
    } catch (err) {
      setErrorMessage("Failed to load session history.");
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!confirm("Are you sure you want to permanently delete this consultation file?")) return;
    
    try {
      // 1. If we are voice chatting in THIS session, stop it immediately
      if (isVoiceActive && currentSessionId === id) {
        stopVoiceSession();
      }

      // 2. Perform UI update first for perceived speed
      const filtered = sessions.filter(s => s.id !== id);
      setSessions(filtered);

      // 3. Purge from Cloud
      await db.deleteSession(id);
      
      // 4. Handle active view state
      if (currentSessionId === id) {
        if (filtered.length > 0) {
          selectSession(filtered[0].id);
        } else {
          createNewSession();
        }
      }
    } catch (err) {
      console.error("Delete Error:", err);
      setErrorMessage("Failed to remove file from server. Restoring list...");
      const loadedSessions = await db.getAllSessions();
      setSessions(loadedSessions);
    }
  };

  const handleLeadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const summary = messages.slice(-5).map(m => `[${m.role}] ${m.text}`).join('\n');
      await db.saveCustomerLead(leadForm, summary);
      setShowLeadModal(false);
      alert("Krishana will contact you soon with your requested data.");
    } catch (err) {
      setErrorMessage("Could not save lead details.");
    }
  };

  const startVoiceSession = async () => {
    if (isVoiceActive) return;
    try {
      setIsVoiceActive(true);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log("Krishana Voice Protocol: Connected");
            const source = audioContextInRef.current!.createMediaStreamSource(mediaStreamRef.current!);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            } else if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              activeSourcesRef.current.add(source);
              source.onended = () => activeSourcesRef.current.delete(source);
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current;
              const modelText = currentOutputTranscription.current;

              if (userText && currentSessionId) {
                const userMsg = { id: crypto.randomUUID(), role: Role.USER, text: userText, timestamp: Date.now() };
                await db.saveMessage(currentSessionId, userMsg);
                setMessages(prev => [...prev, userMsg]);
              }
              if (modelText && currentSessionId) {
                const modelMsg = { id: crypto.randomUUID(), role: Role.MODEL, text: modelText, timestamp: Date.now() };
                await db.saveMessage(currentSessionId, modelMsg);
                setMessages(prev => [...prev, modelMsg]);
              }

              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }
          },
          onerror: (e) => {
            console.error("Voice Sync Error", e);
            setErrorMessage("Voice protocol interrupted.");
            stopVoiceSession();
          },
          onclose: () => {
            console.log("Krishana Voice Protocol: Closed");
            stopVoiceSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: KRISHANA_SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error(err);
      setErrorMessage("Microphone access denied.");
      stopVoiceSession();
    }
  };

  const stopVoiceSession = () => {
    setIsVoiceActive(false);

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextInRef.current) {
      if (audioContextInRef.current.state !== 'closed') {
        audioContextInRef.current.close().catch(() => {});
      }
      audioContextInRef.current = null;
    }

    if (audioContextOutRef.current) {
      if (audioContextOutRef.current.state !== 'closed') {
        audioContextOutRef.current.close().catch(() => {});
      }
      audioContextOutRef.current = null;
    }

    activeSourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    activeSourcesRef.current.clear();

    if (sessionPromiseRef.current) {
      const p = sessionPromiseRef.current;
      sessionPromiseRef.current = null;
      p.then(s => {
        try { s.close(); } catch (e) {}
      });
    }
  };

  const handleSendText = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isTyping || !currentSessionId) return;
    const query = inputText.trim();
    const userMsg = { id: crypto.randomUUID(), role: Role.USER, text: query, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInputText(''); setIsTyping(true);
    await db.saveMessage(currentSessionId, userMsg);

    let modelText = '';
    const modelMsgId = crypto.randomUUID();
    try {
      const stream = sendMessageStream(messages, query);
      for await (const chunk of stream) {
        modelText += chunk;
        setMessages(prev => {
          const existing = prev.find(m => m.id === modelMsgId);
          if (existing) return prev.map(m => m.id === modelMsgId ? { ...m, text: modelText } : m);
          return [...prev, { id: modelMsgId, role: Role.MODEL, text: modelText, timestamp: Date.now() }];
        });
      }
      await db.saveMessage(currentSessionId, { id: modelMsgId, role: Role.MODEL, text: modelText, timestamp: Date.now() });
    } catch (err) { setErrorMessage("Gemini offline."); } finally { setIsTyping(false); }
  };

  const formatPrice = (price: number, currency: string) => {
    if (currency === 'INR') {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
      }).format(price);
    }
    return `${currency} ${price.toLocaleString()}`;
  };

  const PropertyCard = ({ p }: { p: Property }) => {
    const landmark = p.description.match(/Nearby: (.*?)\./)?.[1] || "Prime Location";
    const status = p.description.match(/Status: (.*?)\./)?.[1] || "Available";
    const isRent = p.description.toLowerCase().includes('rent');
    
    return (
      <div className="bg-white border border-slate-100 rounded-3xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-500 group">
        <div className="h-52 bg-slate-50 flex items-center justify-center text-slate-200 relative group-hover:bg-indigo-50 transition-colors overflow-hidden">
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="currentColor" viewBox="0 0 256 256" className="group-hover:scale-110 transition-transform duration-700"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,200v-22.63L82.63,134.74l44,44a16,16,0,0,0,22.63,0l20-20L216,200Z"></path></svg>
          <div className="absolute top-4 right-4 flex flex-col gap-2 items-end">
            <span className={`px-3 py-1 rounded-full text-[10px] font-bold shadow-sm border ${status.includes('Move') ? 'bg-green-50 text-green-600 border-green-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>
              {status.toUpperCase()}
            </span>
            {isRent && (
              <span className="px-3 py-1 bg-indigo-600 text-white rounded-full text-[9px] font-bold shadow-lg">RENTAL</span>
            )}
          </div>
        </div>
        <div className="p-6">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-bold text-slate-800 truncate flex-1 mr-2 text-md leading-tight">{p.name}</h3>
            <span className="text-[10px] bg-slate-50 text-slate-500 px-3 py-1 rounded-full font-bold uppercase tracking-widest">{p.type}</span>
          </div>
          <p className="text-[12px] text-slate-400 flex items-center gap-1.5 mb-1 font-medium">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="text-slate-300"><path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,199.36C109.43,186.27,56,144,56,104a72,72,0,0,1,144,0C200,144,146.57,186.27,128,215.36ZM128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Z"></path></svg>
            {p.city}, India
          </p>
          <p className="text-[12px] text-indigo-400 font-semibold mb-6 flex items-center gap-1.5">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M168,128a40,40,0,1,1-40-40A40,40,0,0,1,168,128Zm64,0A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"></path></svg>
             {landmark}
          </p>
          <div className="flex justify-between items-center pt-4 border-t border-slate-50">
            <div className="flex flex-col">
              <span className="text-lg font-black text-slate-800 leading-none">{formatPrice(p.price, p.currency)}</span>
              {isRent && <span className="text-[10px] text-slate-400 mt-1 font-bold">per month</span>}
            </div>
            <button onClick={() => { setLeadForm({...leadForm, interest_area: p.name}); setShowLeadModal(true); }} className="h-10 px-5 bg-slate-900 text-white rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-indigo-600 transition-all active:scale-95 shadow-lg shadow-slate-100">Inquire</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans">
      {dbSetupRequired && (
        <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-6 text-white text-center">
          <div className="max-w-md space-y-6">
             <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto shadow-lg animate-pulse">
               <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
            </div>
             <h2 className="text-2xl font-bold">SQL Setup Required</h2>
             <p className="text-slate-300 text-sm">Please execute the SQL initialization and data scripts in your Supabase SQL Editor to enable the property portfolio.</p>
             <button onClick={() => window.location.reload()} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 rounded-2xl font-bold transition-all shadow-xl">Refresh Cloud Cache</button>
          </div>
        </div>
      )}

      {showLeadModal && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-[2rem] p-10 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-300 border border-slate-100">
            <h2 className="text-2xl font-black mb-2 text-slate-800">Krishana Inquiries</h2>
            <p className="text-sm text-slate-400 mb-8 leading-relaxed">Exclusive details for <span className="font-bold text-indigo-600">{leadForm.interest_area || 'global properties'}</span> will be shared via your preferred channel.</p>
            <form onSubmit={handleLeadSubmit} className="space-y-4">
              <input required placeholder="Full Name" className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-100 font-medium transition-all" value={leadForm.full_name} onChange={e => setLeadForm({...leadForm, full_name: e.target.value})} />
              <input required type="email" placeholder="Email Address" className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-100 font-medium transition-all" value={leadForm.email} onChange={e => setLeadForm({...leadForm, email: e.target.value})} />
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-bold text-slate-300 uppercase tracking-widest ml-1">Contact Preference</label>
                <select className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-100 font-bold appearance-none transition-all" value={leadForm.preferred_contact} onChange={e => setLeadForm({...leadForm, preferred_contact: e.target.value as any})}>
                  <option value="email">Direct Email Portfolio</option>
                  <option value="sms">SMS Quick Alert</option>
                  <option value="chat">Follow-up in AI Chat</option>
                </select>
              </div>
              <div className="flex gap-4 pt-6">
                <button type="button" onClick={() => setShowLeadModal(false)} className="flex-1 py-4 text-slate-400 font-bold hover:text-slate-600 transition-colors">Dismiss</button>
                <button type="submit" className="flex-1 py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 hover:bg-indigo-700 active:scale-95 transition-all">Submit Case</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <aside className={`fixed inset-y-0 left-0 w-72 bg-white border-r transform transition-transform duration-500 z-30 ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'} md:relative md:translate-x-0`}>
        <div className="flex flex-col h-full">
          <div className="p-8">
            <div className="flex items-center gap-3 mb-12">
              <div className="w-10 h-10 bg-slate-900 rounded-2xl flex items-center justify-center text-white font-black shadow-xl shadow-slate-200">K</div>
              <div className="flex flex-col">
                <span className="font-black text-slate-800 tracking-tighter text-lg leading-none">Krishana</span>
                <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest mt-1">Global Advisor</span>
              </div>
            </div>
            <nav className="space-y-2 mb-12">
              <button onClick={() => setView('chat')} className={`w-full flex items-center gap-4 p-4 rounded-2xl transition-all duration-300 ${view === 'chat' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-400 hover:bg-slate-50'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H192l32,32V64A16,16,0,0,0,216,48ZM216,213.66,198.34,196A8,8,0,0,0,192.69,192H40V64H216Z"></path></svg>
                <span className="text-xs font-black uppercase tracking-widest">Consult</span>
              </button>
              <button onClick={() => setView('properties')} className={`w-full flex items-center gap-4 p-4 rounded-2xl transition-all duration-300 ${view === 'properties' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-400 hover:bg-slate-50'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 256 256"><path d="M240,96a8,8,0,0,0-6.4-7.81L137.6,71.07a16,16,0,0,0-5.2,0L36.4,88.19A8,8,0,0,0,30,96v80a8,8,0,0,0,6.4,7.81l96,17.14a15.86,15.86,0,0,0,5.2,0l96-17.14A8,8,0,0,0,240,176ZM132.85,86.85,212,101,132.85,115.15a16.32,16.32,0,0,0-5.7,0L48,101,127.15,86.85A15.86,15.86,0,0,0,132.85,86.85ZM46,117.15l80,14.28V188L46,173.71ZM134,188V131.43l80-14.28v56.56Z"></path></svg>
                <span className="text-xs font-black uppercase tracking-widest">Holdings</span>
              </button>
            </nav>
            <div className="pt-6 border-t border-slate-50">
              <button onClick={createNewSession} className="w-full py-4 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] hover:shadow-2xl hover:shadow-slate-200 transition-all active:scale-95 shadow-xl shadow-slate-100">New Consultation</button>
            </div>
          </div>
          <div className="mt-auto p-8 space-y-1 overflow-y-auto max-h-64 scrollbar-hide">
            <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest mb-4 px-2">Consultation Files</p>
            {sessions.map(s => (
              <div key={s.id} className="group relative">
                <button 
                  onClick={() => selectSession(s.id)} 
                  className={`w-full text-left p-3 pr-10 rounded-xl text-[11px] font-bold truncate transition-all ${currentSessionId === s.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-400 hover:bg-slate-50'}`}
                >
                  {s.name}
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all active:scale-90"
                  title="Purge consultation file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"></path></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="px-8 py-6 border-b flex justify-between items-center bg-white/80 backdrop-blur-xl sticky top-0 z-20">
          <div className="flex items-center gap-4">
             <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-slate-400 hover:text-indigo-600 transition-colors">
               <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z"></path></svg>
             </button>
             <h1 className="font-black text-slate-800 uppercase tracking-[0.3em] text-[11px]">
               {view === 'chat' ? 'Strategic Advisor' : `Holdings Atlas (${filteredProperties.length})`}
             </h1>
          </div>
          <div className="flex items-center gap-4">
             {view === 'chat' && (
               <button 
                 onClick={isVoiceActive ? stopVoiceSession : startVoiceSession} 
                 className={`flex items-center gap-2 px-4 py-2 rounded-2xl transition-all duration-300 ${isVoiceActive ? 'bg-red-50 text-red-600 border border-red-100 scale-105 shadow-lg' : 'bg-slate-50 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 border border-slate-100'}`}
               >
                 {isVoiceActive ? (
                   <>
                     <div className="flex gap-0.5">
                       <div className="w-1 h-3 bg-red-600 rounded-full animate-bounce"></div>
                       <div className="w-1 h-5 bg-red-600 rounded-full animate-bounce [animation-delay:0.1s]"></div>
                       <div className="w-1 h-3 bg-red-600 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                     </div>
                     <span className="text-[10px] font-black uppercase tracking-widest">End Call</span>
                   </>
                 ) : (
                   <>
                     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0ZM208,128a8,8,0,0,1-16,0,64,64,0,0,0-128,0,8,8,0,0,1-16,0,80,80,0,0,0,72,79.6V232a8,8,0,0,1-16,0,8,8,0,0,1,0-16h32a8,8,0,0,1,0,16,8,8,0,0,1-16,0V207.6A80,80,0,0,0,208,128Z"></path></svg>
                     <span className="text-[10px] font-black uppercase tracking-widest">Voice Protocol</span>
                   </>
                 )}
               </button>
             )}
          </div>
        </header>

        {view === 'chat' ? (
          <>
            <main className="flex-1 overflow-y-auto p-8 flex flex-col gap-8 scrollbar-hide bg-slate-50/20">
              {messages.length === 0 && !isVoiceActive && (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-200 opacity-50">
                  <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" fill="currentColor" viewBox="0 0 256 256" className="animate-pulse"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm40-88a8,8,0,0,1-8,8H136v24a8,8,0,0,1-16,0V136H96a8,8,0,0,1,0-16h24V96a8,8,0,0,1,16,0v24h24A8,8,0,0,1,168,128Z"></path></svg>
                  <p className="mt-6 font-black uppercase tracking-[0.5em] text-[11px]">Protocol Ready</p>
                </div>
              )}
              {isVoiceActive && (
                <div className="flex flex-col items-center justify-center py-10 bg-indigo-50/30 rounded-[3rem] border border-indigo-100/50 mb-10 animate-in fade-in duration-700">
                  <div className="relative">
                    <div className="absolute inset-0 bg-indigo-500 rounded-full animate-ping opacity-20 scale-150"></div>
                    <div className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-2xl relative z-10">
                      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="currentColor" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Z"></path></svg>
                    </div>
                  </div>
                  <h3 className="mt-8 font-black uppercase tracking-[0.3em] text-indigo-700 text-sm">Krishana is Listening</h3>
                  <p className="mt-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Real-time Luxury Advisory Active</p>
                </div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`max-w-[75%] p-5 rounded-[1.5rem] text-[14px] leading-relaxed shadow-sm animate-in slide-in-from-bottom-4 duration-500 ${m.role === Role.USER ? 'bg-indigo-600 text-white self-end rounded-tr-none shadow-indigo-100 shadow-xl' : 'bg-white border border-slate-100 text-slate-700 self-start rounded-tl-none font-medium'}`}>
                  {m.text}
                </div>
              ))}
              {isTyping && <div className="self-start p-3 animate-pulse text-indigo-400 text-[10px] font-black tracking-[0.3em] uppercase ml-2">Deciphering...</div>}
              <div ref={chatEndRef} />
            </main>
            {!isVoiceActive && (
              <footer className="p-8 border-t bg-white">
                <form onSubmit={handleSendText} className="flex gap-5 max-w-5xl mx-auto">
                  <input value={inputText} onChange={e => setInputText(e.target.value)} placeholder="Query the advisor on any listed asset..." className="flex-1 p-5 bg-slate-50 border border-slate-100 rounded-[1.2rem] outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-sm font-medium shadow-inner" />
                  <button type="submit" disabled={!inputText.trim() || isTyping} className="w-16 h-16 bg-slate-900 rounded-[1.2rem] text-white flex items-center justify-center shadow-2xl shadow-slate-200 hover:bg-indigo-600 disabled:bg-slate-100 transition-all active:scale-90 duration-300">
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="currentColor" viewBox="0 0 256 256"><path d="M231.39,123.06,47.39,31a16,16,0,0,0-21,21.82l30.63,71.2a4,4,0,0,1,0,3.14L26.43,198.4a16,16,0,0,0,21,21.82l184-92.06a16,16,0,0,0,0-28.56ZM47.39,204.4,77.53,134H128a8,8,0,0,0,0-16H77.53L47.39,51.6,220.39,128Z"></path></svg>
                  </button>
                </form>
              </footer>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col bg-slate-50/30">
            <div className="px-8 py-5 border-b bg-white/50 backdrop-blur-md flex flex-wrap gap-4 items-center">
              <div className="flex gap-2 overflow-x-auto scrollbar-hide flex-1 py-1">
                {cities.map(c => (
                  <button key={c} onClick={() => setCityFilter(c)} className={`px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap shadow-sm border ${cityFilter === c ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-400 border-slate-100 hover:bg-slate-50'}`}>{c}</button>
                ))}
              </div>
              <div className="relative w-full sm:w-64">
                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search atlas..." className="w-full pl-10 pr-4 py-3 bg-white border border-slate-100 rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-100 shadow-sm" />
                <svg className="absolute left-3 top-3.5 text-slate-300" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path></svg>
              </div>
            </div>
            
            <main className="flex-1 overflow-y-auto p-8 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8 scrollbar-hide">
              {filteredProperties.map(p => <PropertyCard key={p.id} p={p} />)}
              {filteredProperties.length === 0 && (
                <div className="col-span-full py-32 flex flex-col items-center justify-center text-slate-200">
                   <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" fill="currentColor" viewBox="0 0 256 256" className="mb-6 opacity-30"><path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z" opacity="0.2"></path><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
                   <p className="font-black uppercase tracking-[0.4em] text-[12px] opacity-40">Zero coordinates matched</p>
                </div>
              )}
            </main>
          </div>
        )}
        
        {errorMessage && (
          <div className="absolute bottom-24 right-10 left-10 md:left-auto md:w-96 bg-white p-6 rounded-3xl border border-red-50 text-[12px] flex justify-between items-center shadow-2xl animate-in slide-in-from-right-8 duration-500">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
              <span className="text-slate-800 font-bold uppercase tracking-wide leading-none">{errorMessage}</span>
            </div>
            <button onClick={() => setErrorMessage(null)} className="p-2 hover:bg-slate-50 rounded-xl transition-colors">
               <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" className="text-slate-300"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg>
            </button>
          </div>
        )}
      </div>

      {isSidebarOpen && <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-25 md:hidden animate-in fade-in duration-300" onClick={() => setIsSidebarOpen(false)} />}
    </div>
  );
};

export default App;
