
import React, { useState, useEffect, useRef } from 'react';
import { Role, Message, AppMode, ChatSession, Property, CustomerLead, AppView } from './types';
import { sendMessageStream } from './services/gemini';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio';
import { db } from './services/db';

const KRISHANA_SYSTEM_INSTRUCTION = `
System Context: Agent "Krishana"
Role: Global Luxury Real Estate Advisor.
Identity: You are the embodiment of professional serenity.
Brevity: Limit every response to 1-2 concise sentences.
Knowledge: You help clients find exclusive properties in Greece, Japan, USA, and beyond.
Formatting: Plain text only.
`;

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('chat');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [mode, setMode] = useState<AppMode>('text');
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

  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

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
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, view]);

  const createNewSession = async () => {
    const newId = crypto.randomUUID();
    const newSession = { id: newId, name: `Global Inquiry`, messages: [], updatedAt: Date.now() };
    try {
      await (db as any).saveSession(newSession);
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

  // UI Components
  const PropertyCard = ({ p }: { p: Property }) => (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="h-48 bg-slate-200 flex items-center justify-center text-slate-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,200v-22.63L82.63,134.74l44,44a16,16,0,0,0,22.63,0l20-20L216,200Z"></path></svg>
      </div>
      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <h3 className="font-bold text-slate-800 truncate flex-1 mr-2">{p.name}</h3>
          <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded-full font-bold whitespace-nowrap">{p.type}</span>
        </div>
        <p className="text-xs text-slate-500 flex items-center gap-1 mb-3">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,199.36C109.43,186.27,56,144,56,104a72,72,0,0,1,144,0C200,144,146.57,186.27,128,215.36ZM128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Z"></path></svg>
          {p.city}, {p.country}
        </p>
        <div className="flex justify-between items-center">
          <span className="text-lg font-bold text-indigo-600">{p.currency} {Number(p.price).toLocaleString()}</span>
          <button onClick={() => { setLeadForm({...leadForm, interest_area: p.name}); setShowLeadModal(true); }} className="text-xs font-bold text-slate-400 hover:text-indigo-600">Inquire</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Database Warning */}
      {dbSetupRequired && (
        <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-6 text-white text-center">
          <div className="max-w-md space-y-6">
             <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto shadow-lg animate-pulse">
               <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
            </div>
             <h2 className="text-2xl font-bold">SQL Tables Missing</h2>
             <p className="text-slate-300 text-sm">Please execute the SQL initialization script in your Supabase SQL Editor to enable 'properties', 'customers', 'sessions', and 'messages' tables.</p>
             <div className="p-4 bg-slate-800 rounded-lg text-left text-[10px] font-mono border border-slate-700">
               CREATE TABLE properties (...);<br/>
               CREATE TABLE customers (...);
             </div>
             <button onClick={() => window.location.reload()} className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 rounded-xl font-bold transition-all shadow-xl">I've Run the SQL, Refresh</button>
          </div>
        </div>
      )}

      {/* Lead Capture Modal */}
      {showLeadModal && (
        <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl animate-in zoom-in-95">
            <h2 className="text-xl font-bold mb-2">Connect with Krishana</h2>
            <p className="text-sm text-slate-500 mb-6">Receive detailed data and chat logs regarding {leadForm.interest_area || 'global properties'}.</p>
            <form onSubmit={handleLeadSubmit} className="space-y-4">
              <input required placeholder="Full Name" className="w-full p-3 bg-slate-50 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-100" value={leadForm.full_name} onChange={e => setLeadForm({...leadForm, full_name: e.target.value})} />
              <input required type="email" placeholder="Email Address" className="w-full p-3 bg-slate-50 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-100" value={leadForm.email} onChange={e => setLeadForm({...leadForm, email: e.target.value})} />
              <select className="w-full p-3 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-100" value={leadForm.preferred_contact} onChange={e => setLeadForm({...leadForm, preferred_contact: e.target.value as any})}>
                <option value="email">Contact via Email</option>
                <option value="sms">Contact via SMS</option>
                <option value="chat">Follow-up in Chat</option>
              </select>
              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setShowLeadModal(false)} className="flex-1 py-3 text-slate-400 font-bold hover:text-slate-600 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold shadow-lg hover:bg-indigo-700 active:scale-95 transition-all">Submit Inquiry</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 w-64 bg-white border-r transform transition-transform duration-300 z-30 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0`}>
        <div className="flex flex-col h-full">
          <div className="p-6">
            <div className="flex items-center gap-2 mb-8">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold">K</div>
              <span className="font-bold text-slate-700 tracking-tight">Krishana Global</span>
            </div>
            <nav className="space-y-2 mb-8">
              <button onClick={() => setView('chat')} className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${view === 'chat' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H192l32,32V64A16,16,0,0,0,216,48ZM216,213.66,198.34,196A8,8,0,0,0,192.69,192H40V64H216Z"></path></svg>
                <span className="text-sm font-semibold">Advisor Chat</span>
              </button>
              <button onClick={() => setView('properties')} className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${view === 'properties' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M240,96a8,8,0,0,0-6.4-7.81L137.6,71.07a16,16,0,0,0-5.2,0L36.4,88.19A8,8,0,0,0,30,96v80a8,8,0,0,0,6.4,7.81l96,17.14a15.86,15.86,0,0,0,5.2,0l96-17.14A8,8,0,0,0,240,176ZM132.85,86.85,212,101,132.85,115.15a16.32,16.32,0,0,0-5.7,0L48,101,127.15,86.85A15.86,15.86,0,0,0,132.85,86.85ZM46,117.15l80,14.28V188L46,173.71ZM134,188V131.43l80-14.28v56.56Z"></path></svg>
                <span className="text-sm font-semibold">Portfolios</span>
              </button>
            </nav>
            <div className="pt-4 border-t">
              <button onClick={createNewSession} className="w-full p-3 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:shadow-lg transition-all active:scale-95">+ New Consultation</button>
            </div>
          </div>
          <div className="mt-auto p-6 space-y-1 overflow-y-auto max-h-48 scrollbar-hide">
            {sessions.map(s => (
              <button key={s.id} onClick={() => selectSession(s.id)} className={`w-full text-left p-2 rounded-lg text-[11px] truncate transition-colors ${currentSessionId === s.id ? 'bg-indigo-50 text-indigo-700 font-bold' : 'text-slate-400 hover:bg-slate-50'}`}>{s.name}</button>
            ))}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="p-4 border-b flex justify-between items-center bg-white/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center gap-3">
             <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-slate-400 hover:text-indigo-600 transition-colors">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z"></path></svg>
             </button>
             <h1 className="font-bold text-slate-700 uppercase tracking-widest text-xs">
               {view === 'chat' ? 'Advisor Protocol' : 'Global Portfolios'}
             </h1>
          </div>
          <button onClick={() => setShowLeadModal(true)} className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full uppercase tracking-tighter hover:bg-indigo-100 transition-colors">Stay Notified</button>
        </header>

        {view === 'chat' ? (
          <>
            <main className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 scrollbar-hide">
              {messages.map(m => (
                <div key={m.id} className={`max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm animate-in slide-in-from-bottom-2 duration-300 ${m.role === Role.USER ? 'bg-indigo-600 text-white self-end rounded-tr-none shadow-indigo-100' : 'bg-slate-50 border border-slate-100 text-slate-700 self-start rounded-tl-none'}`}>
                  {m.text}
                </div>
              ))}
              {isTyping && <div className="self-start p-2 animate-pulse text-indigo-400 text-xs font-medium tracking-widest uppercase">Thinking...</div>}
              <div ref={chatEndRef} />
            </main>
            <footer className="p-6 border-t bg-white">
              <form onSubmit={handleSendText} className="flex gap-4">
                <input value={inputText} onChange={e => setInputText(e.target.value)} placeholder="Inquire about property markets..." className="flex-1 p-4 bg-slate-50 border border-slate-100 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-100 transition-all" />
                <button type="submit" disabled={!inputText.trim() || isTyping} className="w-14 h-14 bg-indigo-600 rounded-2xl text-white flex items-center justify-center shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:bg-slate-200 transition-all active:scale-95"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M231.39,123.06,47.39,31a16,16,0,0,0-21,21.82l30.63,71.2a4,4,0,0,1,0,3.14L26.43,198.4a16,16,0,0,0,21,21.82l184-92.06a16,16,0,0,0,0-28.56ZM47.39,204.4,77.53,134H128a8,8,0,0,0,0-16H77.53L47.39,51.6,220.39,128Z"></path></svg></button>
              </form>
            </footer>
          </>
        ) : (
          <main className="flex-1 overflow-y-auto p-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6 scrollbar-hide">
            {properties.map(p => <PropertyCard key={p.id} p={p} />)}
            {properties.length === 0 && (
              <div className="col-span-full py-20 flex flex-col items-center justify-center opacity-30">
                 <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="currentColor" viewBox="0 0 256 256" className="mb-4"><path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z" opacity="0.2"></path><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,168Z"></path></svg>
                 <p className="font-bold uppercase tracking-widest text-sm">No listings found in cloud cache</p>
              </div>
            )}
          </main>
        )}
        
        {errorMessage && (
          <div className="absolute bottom-24 right-6 left-6 md:left-auto md:w-80 bg-red-50 text-red-600 p-3 rounded-xl border border-red-100 text-xs flex justify-between items-center shadow-lg animate-in fade-in slide-in-from-right-4">
            <span>{errorMessage}</span>
            <button onClick={() => setErrorMessage(null)} className="p-1 hover:bg-red-100 rounded">
               <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg>
            </button>
          </div>
        )}
      </div>

      {isSidebarOpen && <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-25 md:hidden" onClick={() => setIsSidebarOpen(false)} />}
    </div>
  );
};

export default App;
