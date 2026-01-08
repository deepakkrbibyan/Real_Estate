
import { ChatSession, Message, Property, CustomerLead } from '../types';
import { supabase } from './supabase';

export class KrishanaSupabaseDB {
  private isTableMissingError(error: any): boolean {
    if (!error) return false;
    const msg = error.message || "";
    // Check for common "table not found" indicators from Supabase/PostgREST
    return (
      msg.includes("schema cache") || 
      msg.includes("does not exist") || 
      error.code === '42P01' || 
      error.code === 'PGRST116'
    );
  }

  async init(): Promise<void> {
    const { error } = await supabase.from('sessions').select('id').limit(1);
    if (error && this.isTableMissingError(error)) {
      throw new Error("TABLES_NOT_FOUND");
    }
  }

  async getAllSessions(): Promise<ChatSession[]> {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      if (this.isTableMissingError(error)) throw new Error("TABLES_NOT_FOUND");
      console.error("Supabase Error (getAllSessions):", error.message);
      return [];
    }

    return (data || []).map(s => ({
      id: s.id,
      name: s.name,
      messages: [],
      updatedAt: Number(s.updated_at)
    }));
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    const { data: sessionData, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single();

    if (sessionError) {
      console.error("Supabase Error (getSession meta):", sessionError.message);
      return undefined;
    }

    const { data: messageData } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', id)
      .order('timestamp', { ascending: true });

    return {
      id: sessionData.id,
      name: sessionData.name,
      updatedAt: Number(sessionData.updated_at),
      messages: (messageData || []).map(m => ({
        id: m.id,
        role: m.role,
        text: m.text,
        timestamp: Number(m.timestamp)
      }))
    };
  }

  async saveSession(session: ChatSession): Promise<void> {
    const { error } = await supabase.from('sessions').upsert({
      id: session.id,
      name: session.name,
      updated_at: session.updatedAt
    });
    if (error) {
      console.error("Supabase Error (saveSession):", error.message);
      throw error;
    }
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const { error: mError } = await supabase.from('messages').upsert({
      id: message.id,
      session_id: sessionId,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp
    });
    
    if (mError) console.error("Supabase Error (saveMessage):", mError.message);
    
    await supabase.from('sessions').update({ updated_at: Date.now() }).eq('id', sessionId);
  }

  async deleteSession(id: string): Promise<void> {
    const { error } = await supabase.from('sessions').delete().eq('id', id);
    if (error) console.error("Supabase Error (deleteSession):", error.message);
  }

  async clearSessionMessages(id: string): Promise<void> {
    const { error } = await supabase.from('messages').delete().eq('session_id', id);
    if (error) console.error("Supabase Error (clearSessionMessages):", error.message);
  }

  async clearAll(): Promise<void> {
    const dummyId = '00000000-0000-0000-0000-000000000000';
    await supabase.from('messages').delete().neq('id', dummyId);
    await supabase.from('sessions').delete().neq('id', dummyId);
  }

  // --- NEW BUSINESS METHODS ---

  async getProperties(): Promise<Property[]> {
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .order('country', { ascending: true });
    
    if (error) {
      if (this.isTableMissingError(error)) {
        throw new Error("TABLES_NOT_FOUND");
      }
      console.error("Property fetch error:", error.message);
      return [];
    }
    return data || [];
  }

  async saveCustomerLead(lead: CustomerLead, chatSummary: string): Promise<void> {
    const { error } = await supabase
      .from('customers')
      .insert({
        full_name: lead.full_name,
        email: lead.email,
        phone: lead.phone,
        preferred_contact: lead.preferred_contact,
        interest_area: lead.interest_area,
        last_chat_summary: chatSummary
      });
    
    if (error) {
      console.error("Lead save error:", error.message);
      throw error;
    }
  }
}

export const db = new KrishanaSupabaseDB();
