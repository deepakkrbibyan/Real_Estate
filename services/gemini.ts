
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Message, Role } from "../types";

const KRISHANA_SYSTEM_INSTRUCTION = `
System Context: Agent "Krishana"
Role: Intelligent Voice Assistant.
Identity: You are the embodiment of professional serenity.
Brevity: You MUST be extremely brief. Limit every response to 1-2 concise sentences. Avoid lists, long explanations, or pleasantries unless requested.
Tone: Calm, professional, and precise.
Formatting: Plain text only. No markdown.
`;

export async function* sendMessageStream(
  history: Message[],
  message: string
) {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

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
        systemInstruction: KRISHANA_SYSTEM_INSTRUCTION,
        temperature: 0.3, // Significantly lower temperature for maximum precision and minimal rambling
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
