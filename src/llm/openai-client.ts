import OpenAI from "openai";
import type { Settings } from "../config/settings.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
}

export class LLMClient {
  private readonly client: OpenAI;
  private readonly settings: Settings;

  constructor(settings: Settings) {
    if (!settings.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required to use the assistant");
    }

    this.settings = settings;
    this.client = new OpenAI({
      apiKey: settings.openAiApiKey,
      baseURL: settings.openAiBaseUrl
    });
  }

  async complete(messages: ChatMessage[], options?: Partial<{ model: string; temperature: number; maxOutputTokens: number }>): Promise<CompletionResult> {
    const response = await this.client.responses.create({
      model: options?.model ?? this.settings.defaultModel.model,
      temperature: options?.temperature ?? this.settings.defaultModel.temperature,
      max_output_tokens: options?.maxOutputTokens ?? this.settings.defaultModel.maxOutputTokens,
      input: messages.map(({ role, content }) => ({ role, content }))
    });

    const textParts: string[] = [];
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type !== "message") continue;
        const segments = Array.isArray(item.content) ? item.content : [];
        for (const segment of segments) {
          if (isTextSegment(segment)) {
            const value = Array.isArray(segment.text) ? segment.text.join("") : segment.text ?? "";
            if (value) {
              textParts.push(value);
            }
          }
        }
      }
    }

    return {
      content: textParts.join("\n").trim(),
      model: response.model ?? options?.model ?? this.settings.defaultModel.model,
      usagePromptTokens: response.usage?.input_tokens,
      usageCompletionTokens: response.usage?.output_tokens
    };
  }
}

interface ResponseTextSegment {
  type: "output_text";
  text?: string | string[];
}

function isTextSegment(segment: unknown): segment is ResponseTextSegment {
  return Boolean(
    segment &&
      typeof segment === "object" &&
      (segment as { type?: unknown }).type === "output_text"
  );
}
