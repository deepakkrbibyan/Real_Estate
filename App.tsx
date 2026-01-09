
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Role, Message, ChatSession, Property, CustomerLead, AppView } from './types';
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

const FALLBACK_ICON_URL = "https://raw.githubusercontent.com/ai-web-designs/assets/refs/heads/main/krishana_portrait.jpg";

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('chat');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [lastSync, setLastSync] = useState<number>(Date.now());
  const [isSyncing, setIsSyncing] = useState(false);
  const [appIcon, setAppIcon] = useState<string>(FALLBACK_ICON_URL);
  
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

  // Filter State
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
        await refreshData();
        // Fetch custom branding icon from DB
        const dbIcon = await db.getBranding('app_icon');
        if (dbIcon) setAppIcon(dbIcon);
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

  const refreshData = async () => {
    setIsSyncing(true);
    try {
      const [loadedSessions, loadedProperties] = await Promise.all([
        db.getAllSessions(),
        db.getProperties()
      ]);
      setSessions(loadedSessions);
      setProperties(loadedProperties);
      setLastSync(Date.now());
      if (loadedSessions.length > 0 && !currentSessionId) {
        selectSession(loadedSessions[0].id);
      } else if (loadedSessions.length === 0) {
        createNewSession();
      }
    } catch (err) {
      setErrorMessage("Data synchronization failed.");
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, view, isVoiceActive]);

  const filteredProperties = useMemo(() => {
    return properties.filter(p => {
      const query = searchQuery.toLowerCase();
      return p.name.toLowerCase().includes(query) || 
             p.description.toLowerCase().includes(query) ||
             p.city.toLowerCase().includes(query) ||
             p.type.toLowerCase().includes(query);
    });
  }, [properties, searchQuery]);

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

  const handleConsultProperty = (p: Property) => {
    setView('chat');
    const introMsg = `I would like to discuss details about ${p.name} in ${p.city}. What can you tell me about this asset?`;
    setInputText(introMsg);
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

      const propertyContext = properties.length > 0 
        ? `\nKNOWLEDGE BASE (Synchronized Portfolio):\n${properties.map(p => `- ${p.name} in ${p.city}: ${p.currency} ${p.price.toLocaleString()}`).join('\n')}`
        : "";

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
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
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
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
          onerror: (e) => { setErrorMessage("Voice protocol interrupted."); stopVoiceSession(); },
          onclose: () => { stopVoiceSession(); }
        },
        config: {
          // Fix: Corrected typo 'responseModalalities' to 'responseModalities'
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: KRISHANA_SYSTEM_INSTRUCTION + propertyContext,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
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
      if (audioContextInRef.current.state !== 'closed') audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      if (audioContextOutRef.current.state !== 'closed') audioContextOutRef.current.close().catch(() => {});
      audioContextOutRef.current = null;
    }
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    activeSourcesRef.current.clear();
    if (sessionPromiseRef.current) {
      const p = sessionPromiseRef.current;
      sessionPromiseRef.current = null;
      p.then(s => { try { s.close(); } catch (e) {} });
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
      const stream = sendMessageStream(messages, query, properties);
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

  const renderPropertyCard = (p: Property) => {
    const landmark = p.description.match(/Nearby: (.*?)\./)?.[1] || "Prime Location";
    const status = p.description.match(/Status: (.*?)\./)?.[1] || "Available";
    const isRent = p.description.toLowerCase().includes('rent');
    
    return (
      <div key={p.id} className="bg-white border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-sm hover:shadow-2xl transition-all duration-700 group flex flex-col h-full">
        <div className="h-64 bg-slate-50 flex items-center justify-center text-slate-200 relative group-hover:bg-indigo-50 transition-colors overflow-hidden shrink-0">
          {p.image_url ? (
            <img src={p.image_url} alt={p.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-1000" />
          ) : (
            <div className="flex flex-col items-center gap-4 opacity-20 group-hover:opacity-40 transition-opacity">
              <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" fill="currentColor" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM216,56V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,200v-22.63L82.63,134.74l44,44a16,16,0,0,0,22.63,0l20-20L216,200Z"></path></svg>
              <span className="text-[10px] font-black uppercase tracking-[0.3em]">No Image Found</span>
            </div>
          )}
          <div className="absolute top-6 right-6 flex flex-col gap-3 items-end">
            <span className={`px-4 py-1.5 rounded-full text-[10px] font-black shadow-lg border backdrop-blur-md ${status.toLowerCase().includes('move') ? 'bg-green-500/90 text-white border-green-400' : 'bg-amber-500/90 text-white border-amber-400'}`}>
              {status.toUpperCase()}
            </span>
            {isRent && (
              <span className="px-4 py-1.5 bg-indigo-600/90 text-white rounded-full text-[10px] font-black shadow-lg backdrop-blur-md border border-indigo-400">RENTAL</span>
            )}
          </div>
        </div>
        <div className="p-8 flex-1 flex flex-col">
          <div className="flex justify-between items-start mb-4">
            <h3 className="font-black text-slate-800 truncate flex-1 mr-4 text-xl leading-none">{p.name}</h3>
            <span className="text-[10px] bg-slate-900 text-white px-4 py-1.5 rounded-full font-black uppercase tracking-widest shadow-lg shadow-slate-100 shrink-0">{p.type}</span>
          </div>
          <p className="text-[13px] text-slate-400 flex items-center gap-2 mb-2 font-bold">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" className="text-indigo-400"><path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,199.36C109.43,186.27,56,144,56,104a72,72,0,0,1,144,0C200,144,146.57,186.27,128,215.36ZM128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Z"></path></svg>
            {p.city}, India
          </p>
          <p className="text-[13px] text-indigo-500 font-bold mb-8 flex items-center gap-2 bg-indigo-50/50 p-2 rounded-xl self-start">
             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M168,128a40,40,0,1,1-40-40A40,40,0,0,1,168,128Zm64,0A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"></path></svg>
             {landmark}
          </p>
          <div className="flex justify-between items-center mt-auto pt-6 border-t border-slate-50">
            <div className="flex flex-col">
              <span className="text-2xl font-black text-slate-800 tracking-tighter">{formatPrice(p.price, p.currency)}</span>
              {isRent && <span className="text-[10px] text-slate-400 mt-1 font-black uppercase tracking-widest">per month</span>}
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => handleConsultProperty(p)} 
                className="w-12 h-12 flex items-center justify-center bg-indigo-50 text-indigo-600 rounded-2xl hover:bg-indigo-600 hover:text-white transition-all active:scale-90"
                title="Discuss this property with Krishana"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H192l32,32V64A16,16,0,0,0,216,48Z"></path></svg>
              </button>
              <button 
                onClick={() => { setLeadForm({...leadForm, interest_area: p.name}); setShowLeadModal(true); }} 
                className="h-12 px-6 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] hover:bg-indigo-600 transition-all active:scale-95 shadow-xl shadow-slate-200"
              >
                Inquire
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900 font-sans">
      {dbSetupRequired && (
        <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-6 text-white text-center">
          <div className="max-w-md space-y-6">
             <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto shadow-lg animate-pulse">
               <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
            </div>
             <h2 className="text-2xl font-bold">Portfolio Database Inactive</h2>
             <p className="text-slate-300 text-sm">To browse our luxury holdings, please initialize the 'properties' table in your Supabase SQL editor.</p>
             <button onClick={() => window.location.reload()} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 rounded-2xl font-bold transition-all shadow-xl">Re-establish Pulse</button>
          </div>
        </div>
      )}

      {showLeadModal && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] p-12 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-300 border border-slate-100">
            <h2 className="text-3xl font-black mb-2 text-slate-800 tracking-tighter">Krishana Briefing</h2>
            <p className="text-sm text-slate-400 mb-10 leading-relaxed font-medium">Your request for <span className="font-bold text-indigo-600">{leadForm.interest_area || 'global assets'}</span> is being prepared for immediate dispatch.</p>
            <form onSubmit={handleLeadSubmit} className="space-y-5">
              <div className="group">
                <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest ml-1 mb-2 block">Identity</label>
                <input required placeholder="Full Name" className="w-full p-5 bg-slate-50 border border-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-indigo-50 font-bold transition-all" value={leadForm.full_name} onChange={e => setLeadForm({...leadForm, full_name: e.target.value})} />
              </div>
              <div className="group">
                <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest ml-1 mb-2 block">Channel</label>
                <input required type="email" placeholder="Secure Email Address" className="w-full p-5 bg-slate-50 border border-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-indigo-50 font-bold transition-all" value={leadForm.email} onChange={e => setLeadForm({...leadForm, email: e.target.value})} />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest ml-1 mb-2 block">Preferred Protocol</label>
                <select className="w-full p-5 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-50 font-black appearance-none transition-all cursor-pointer" value={leadForm.preferred_contact} onChange={e => setLeadForm({...leadForm, preferred_contact: e.target.value as any})}>
                  <option value="email">Formal Digital Portfolio</option>
                  <option value="sms">Immediate SMS Alert</option>
                  <option value="chat">Continued AI Consultation</option>
                </select>
              </div>
              <div className="flex gap-6 pt-10">
                <button type="button" onClick={() => setShowLeadModal(false)} className="flex-1 py-5 text-slate-400 font-black uppercase tracking-widest text-[11px] hover:text-slate-600 transition-colors">Abort</button>
                <button type="submit" className="flex-2 py-5 bg-slate-900 text-white rounded-[1.5rem] font-black uppercase tracking-[0.2em] text-[11px] shadow-2xl shadow-slate-300 hover:bg-indigo-600 active:scale-95 transition-all">Submit Briefing</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <aside className={`fixed inset-y-0 left-0 w-80 bg-white border-r transform transition-transform duration-500 z-30 ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'} md:relative md:translate-x-0 h-full flex flex-col shrink-0`}>
        <div className="flex flex-col h-full overflow-hidden">
          <div className="p-10 shrink-0">
            <div className="flex items-center gap-4 mb-16">
              <img 
                src={appIcon} 
                className="w-14 h-14 rounded-full object-cover shadow-2xl shadow-indigo-200 border-2 border-amber-100" 
                alt="Krishana" 
              />
              <div className="flex flex-col">
                <span className="font-black text-slate-800 tracking-tighter text-2xl leading-none">Krishana</span>
                <span className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.3em] mt-2">Elite Advisor</span>
              </div>
            </div>
            <nav className="space-y-3 mb-16">
              <button 
                onClick={() => { setView('chat'); if(isVoiceActive) stopVoiceSession(); }} 
                className={`w-full flex items-center gap-5 p-5 rounded-[1.5rem] transition-all duration-300 ${view === 'chat' && !isVoiceActive ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-400 hover:bg-slate-50'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H192l32,32V64A16,16,0,0,0,216,48Z"></path></svg>
                <span className="text-[11px] font-black uppercase tracking-[0.2em]">Consult</span>
              </button>

              <button 
                onClick={() => { setView('chat'); isVoiceActive ? stopVoiceSession() : startVoiceSession(); }} 
                className={`w-full flex items-center gap-5 p-5 rounded-[1.5rem] transition-all duration-300 ${isVoiceActive ? 'bg-red-50 text-red-700 shadow-xl shadow-red-100 ring-2 ring-red-100' : 'text-slate-400 hover:bg-slate-50'}`}
              >
                <div className="relative">
                  {isVoiceActive && <div className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-ping"></div>}
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM208,128a8,8,0,0,1-16,0,64,64,0,0,0-128,0,8,8,0,0,1-16,0,80,80,0,0,0,72,79.6V232a8,8,0,0,1-16,0,8,8,0,0,1,0-16h32a8,8,0,0,1,0,16,8,8,0,0,1-16,0V207.6A80,80,0,0,0,208,128Z"></path></svg>
                </div>
                <span className="text-[11px] font-black uppercase tracking-[0.2em]">Advisor Call</span>
              </button>

              <button onClick={() => setView('properties')} className={`w-full flex items-center gap-5 p-5 rounded-[1.5rem] transition-all duration-300 ${view === 'properties' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-400 hover:bg-slate-50'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M240,96a8,8,0,0,0-6.4-7.81L137.6,71.07a16,16,0,0,0-5.2,0L36.4,88.19A8,8,0,0,0,30,96v80a8,8,0,0,0,6.4,7.81l96,17.14a15.86,15.86,0,0,0,5.2,0l96-17.14A8,8,0,0,0,240,176Z"></path></svg>
                <span className="text-[11px] font-black uppercase tracking-[0.2em]">Holdings</span>
              </button>
            </nav>
          </div>
          <div className="mt-auto p-10 flex flex-col items-center justify-center opacity-10">
             <img src={appIcon} className="w-16 h-16 rounded-full grayscale mb-4" alt="Krishana BG" />
             <div className="w-24 h-2 bg-slate-200 rounded-full mb-2"></div>
             <div className="w-16 h-2 bg-slate-200 rounded-full"></div>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 bg-white relative h-full">
        <header className="px-10 py-8 border-b flex justify-between items-center bg-white/80 backdrop-blur-xl shrink-0 z-20">
          <div className="flex items-center gap-6">
             <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-3 text-slate-400 hover:text-indigo-600 transition-colors bg-slate-50 rounded-xl">
               <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z"></path></svg>
             </button>
             <div className="flex flex-col">
               <h1 className="font-black text-slate-800 uppercase tracking-[0.4em] text-[12px] leading-none">
                 {view === 'chat' ? (isVoiceActive ? 'Advisor Call Active' : 'Strategic Intelligence') : 'Holdings Atlas'}
               </h1>
               <div className="flex items-center gap-2 mt-2">
                 <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${isVoiceActive ? 'bg-red-500' : 'bg-green-500'}`}></div>
                 <span className="text-[9px] font-black uppercase text-slate-300 tracking-[0.2em]">
                    {isVoiceActive ? 'Audio Stream Encrypted' : 'Real-time DB Connection Active'}
                 </span>
               </div>
             </div>
          </div>
          <div className="flex items-center gap-6">
             {view === 'properties' && (
               <div className="flex items-center gap-6">
                 <div className="hidden sm:flex flex-col items-end">
                   <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest mb-1">Portfolio Verified</span>
                   <span className="text-[10px] font-bold text-indigo-500">
                     {new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                   </span>
                 </div>
                 <button 
                   onClick={refreshData} 
                   disabled={isSyncing}
                   className={`p-4 rounded-2xl border border-slate-100 hover:bg-slate-50 transition-all shadow-sm ${isSyncing ? 'animate-spin text-indigo-500 border-indigo-200 bg-indigo-50' : 'text-slate-400 hover:text-indigo-600'}`}
                   title="Refresh Atlas"
                 >
                   <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 256 256"><path d="M224,128a96,96,0,0,1-94.72,96H128A96,96,0,0,1,32,128a96,96,0,0,1,160-72.11V40a8,8,0,0,1,16,0V80a8,8,0,0,1-8,8H160a8,8,0,0,1,0-16h24.49A80,80,0,1,0,48,128a80,80,0,0,0,136,56.57,8,8,0,0,1,11.31,11.32A95.45,95.45,0,0,1,128,224h-1.28A96,96,0,0,1,224,128,8,8,0,0,1,224,128Z"></path></svg>
                 </button>
               </div>
             )}
          </div>
        </header>

        {view === 'chat' ? (
          <>
            <main className="flex-1 overflow-y-auto p-10 flex flex-col gap-10 scrollbar-hide bg-slate-50/20">
              {messages.length === 0 && !isVoiceActive && (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-200">
                  <div className="relative mb-12">
                    <div className="absolute inset-0 bg-indigo-100 rounded-full animate-pulse blur-3xl opacity-30"></div>
                    <img 
                      src={appIcon} 
                      className="w-48 h-48 rounded-full object-cover shadow-[0_35px_60px_-15px_rgba(0,0,0,0.3)] border-4 border-white relative z-10 grayscale hover:grayscale-0 transition-all duration-1000" 
                      alt="Krishana Placeholder" 
                    />
                  </div>
                  <p className="font-black uppercase tracking-[0.6em] text-[12px] text-slate-300">Awaiting Consultation Protocols</p>
                </div>
              )}
              {isVoiceActive && (
                <div className="flex flex-col items-center justify-center py-16 bg-white rounded-[4rem] border border-slate-100 shadow-2xl shadow-red-100/10 mb-10 animate-in zoom-in-95 duration-1000">
                  <div className="relative">
                    <div className="absolute inset-0 bg-red-500 rounded-full animate-ping opacity-10 scale-150"></div>
                    <div className="absolute inset-0 bg-red-500 rounded-full animate-pulse opacity-5 scale-125"></div>
                    <div className="w-32 h-32 rounded-full overflow-hidden shadow-2xl relative z-10 border-4 border-red-50">
                       <img src={appIcon} className="w-full h-full object-cover" alt="Active Call" />
                    </div>
                  </div>
                  <h3 className="mt-12 font-black uppercase tracking-[0.5em] text-slate-800 text-sm">Advisor Listening</h3>
                  <div className="mt-6 flex gap-1.5">
                    {[1,2,3,4,5].map(i => <div key={i} className="w-1.5 h-1.5 bg-red-200 rounded-full animate-bounce" style={{animationDelay: `${i*0.1}s`}}></div>)}
                  </div>
                </div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`max-w-[70%] p-6 rounded-[2rem] text-[15px] leading-[1.6] shadow-xl animate-in slide-in-from-bottom-6 duration-700 ${m.role === Role.USER ? 'bg-slate-900 text-white self-end rounded-tr-none shadow-slate-200' : 'bg-white border border-slate-100 text-slate-700 self-start rounded-tl-none font-bold shadow-slate-100/50'}`}>
                  {m.text}
                </div>
              ))}
              {isTyping && <div className="self-start p-4 animate-pulse text-indigo-500 text-[11px] font-black tracking-[0.4em] uppercase ml-4">Deciphering Holding Records...</div>}
              <div ref={chatEndRef} />
            </main>
            {!isVoiceActive && (
              <footer className="p-10 border-t bg-white shrink-0">
                <form onSubmit={handleSendText} className="flex gap-6 max-w-6xl mx-auto items-center">
                  <div className="flex-1 relative">
                    <input value={inputText} onChange={e => setInputText(e.target.value)} placeholder="Inquire about property specifics or market analytics..." className="w-full p-6 bg-slate-50 border border-slate-100 rounded-[2rem] outline-none focus:ring-8 focus:ring-indigo-50 transition-all text-[15px] font-bold shadow-inner placeholder:text-slate-300 placeholder:uppercase placeholder:tracking-widest placeholder:text-[11px]" />
                    <div className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center gap-3">
                       <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                    </div>
                  </div>
                  <button type="submit" disabled={!inputText.trim() || isTyping} className="w-20 h-20 bg-slate-900 rounded-[2rem] text-white flex items-center justify-center shadow-2xl shadow-slate-300 hover:bg-indigo-600 disabled:bg-slate-100 transition-all active:scale-90 duration-500 group">
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 256 256" className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform"><path d="M231.39,123.06,47.39,31a16,16,0,0,0-21,21.82l30.63,71.2a4,4,0,0,1,0,3.14L26.43,198.4a16,16,0,0,0,21,21.82l184-92.06a16,16,0,0,0,0-28.56ZM47.39,204.4,77.53,134H128a8,8,0,0,0,0-16H77.53L47.39,51.6,220.39,128Z"></path></svg>
                  </button>
                </form>
              </footer>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col bg-slate-50/40 overflow-hidden">
            <div className="px-10 py-6 border-b bg-white/60 backdrop-blur-2xl flex items-center shrink-0">
              <div className="relative flex-1">
                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Query Atlas by Name, City, or Landmark..." className="w-full pl-14 pr-6 py-5 bg-white border border-slate-100 rounded-[1.5rem] text-[12px] font-black outline-none focus:ring-8 focus:ring-indigo-50 shadow-sm placeholder:uppercase placeholder:tracking-widest placeholder:text-slate-300" />
                <svg className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path></svg>
              </div>
            </div>
            
            <main className="flex-1 overflow-y-auto p-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-10 scrollbar-hide">
              {filteredProperties.map(p => renderPropertyCard(p))}
              {filteredProperties.length === 0 && (
                <div className="col-span-full py-48 flex flex-col items-center justify-center text-slate-200">
                   <div className="w-32 h-32 bg-slate-50 rounded-[4rem] flex items-center justify-center mb-8">
                     <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" fill="currentColor" viewBox="0 0 256 256" className="opacity-10"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
                   </div>
                   <p className="font-black uppercase tracking-[0.5em] text-[14px] opacity-30">Zero Holdings Match This Query</p>
                </div>
              )}
            </main>
          </div>
        )}
        
        {errorMessage && (
          <div className="absolute bottom-32 right-12 left-12 md:left-auto md:w-[450px] bg-white p-8 rounded-[2.5rem] border border-red-50 text-[13px] flex justify-between items-center shadow-2xl animate-in slide-in-from-right-12 duration-700 z-50">
            <div className="flex items-center gap-5">
              <div className="w-4 h-4 rounded-full bg-red-500 animate-ping"></div>
              <div className="flex flex-col">
                <span className="text-slate-800 font-black uppercase tracking-widest leading-none">Protocol Interrupted</span>
                <span className="text-slate-400 font-bold mt-2">{errorMessage}</span>
              </div>
            </div>
            <button onClick={() => setErrorMessage(null)} className="p-3 hover:bg-slate-50 rounded-2xl transition-colors">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256" className="text-slate-300"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg>
            </button>
          </div>
        )}
      </div>

      {isSidebarOpen && <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xl z-25 md:hidden animate-in fade-in duration-500" onClick={() => setIsSidebarOpen(false)} />}
    </div>
  );
};

export default App;
