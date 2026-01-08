
export enum Role {
  USER = 'user',
  MODEL = 'model'
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
  updatedAt: number;
}

export interface Property {
  id: string;
  name: string;
  country: string;
  city: string;
  price: number;
  currency: string;
  description: string;
  image_url?: string;
  type: string;
}

export interface CustomerLead {
  full_name: string;
  email: string;
  phone?: string;
  preferred_contact: 'email' | 'sms' | 'chat';
  interest_area?: string;
}

export type AppMode = 'text' | 'voice';
export type AppView = 'chat' | 'properties';
