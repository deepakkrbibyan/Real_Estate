
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Message, Role, Property } from "../types";

const KRISHANA_BASE_INSTRUCTION = `
System Context: Agent "Krishana"
Role: Global Luxury Real Estate Advisor.
Identity: You are the embodiment of professional serenity.
Brevity: Limit responses to 1-2 concise sentences.
Tone: Calm, professional, and precise.
Formatting: Plain text only. No markdown.
`;

export async function* sendMessageStream(
  history: Message[],
  message: string,
  properties: Property[] = []
) {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // Create property context for the AI
  const propertyContext = properties.length > 0 
    ? `\nCURRENT HOLDINGS ATLAS:\n${properties.map(p => `- ${p.name} in ${p.city}: ${p.currency} ${p.price.toLocaleString()} (${p.type})`).join('\n')}`
    : "";

  const systemInstruction = KRISHANA_BASE_INSTRUCTION + propertyContext;

  const geminiHistory = [];
  let lastRole = null;

  for (const m of history) {
    const role = m.role === Role.USER ? 'user' : 'model';
    if (role !== lastRole) {
      geminiHistory.push({
        role: role,
        parts: [{ text: m.text || "..." }]
      });
      lastRole = role;
    }
  }

  try {
    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.2, // Lower temperature for factual accuracy regarding the DB
        topP: 0.8,
      },
      history: geminiHistory
    });

    const result = await chat.sendMessageStream({ message });
    
    for await (const chunk of result) {
      const c = chunk as GenerateContentResponse;
      if (c.text) {
        yield c.text;
      }
    }
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}
