import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  news?: NewsItem[];
  warning?: string;
  isPartial?: boolean;
  responseMs?: number;
  newsCount?: number;
  model?: string;
  provider?: string;
  createdAt?: string;
}

export interface NewsItem {
  title: string;
  source: string;
  date: string;
  snippet: string;
  link: string;
}

export interface ChatResponse {
  message: ChatMessage;
  news?: NewsItem[];
  warning?: string;
  isPartial?: boolean;
}

export type AiStatusStage =
  | 'preparing'
  | 'calling_model'
  | 'fetching_news'
  | 'synthesizing'
  | 'finalizing';

export interface ChatStreamMeta {
  responseMs: number;
  isPartial: boolean;
  newsCount: number;
  model: string;
  provider: string;
}

export interface ChatDonePayload {
  message: ChatMessage;
  news?: NewsItem[];
  warning?: string;
  isPartial: boolean;
  meta: ChatStreamMeta;
}

export type ChatStreamEvent =
  | { type: 'status'; stage: AiStatusStage; message: string }
  | { type: 'token'; token: string }
  | { type: 'meta'; meta: ChatStreamMeta }
  | { type: 'done'; payload: ChatDonePayload }
  | { type: 'error'; message: string };

interface ApiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly apiUrl = 'http://localhost:3000/ai/chat';
  private readonly streamApiUrl = 'http://localhost:3000/ai/chat/stream';

  constructor(private http: HttpClient) {}

  chat(messages: ChatMessage[]): Observable<ChatResponse> {
    const apiMessages: ApiChatMessage[] = messages.map(({ role, content }) => ({
      role,
      content,
    }));

    return this.http.post<ChatResponse>(this.apiUrl, { messages: apiMessages });
  }

  chatStream(messages: ChatMessage[]): Observable<ChatStreamEvent> {
    const apiMessages: ApiChatMessage[] = messages.map(({ role, content }) => ({
      role,
      content,
    }));

    return new Observable<ChatStreamEvent>((observer) => {
      const controller = new AbortController();

      fetch(this.streamApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ messages: apiMessages }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            throw new Error(`Streaming request failed (${response.status})`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const parseEventBlock = (block: string): ChatStreamEvent | null => {
            const lines = block.split('\n');
            let eventType = '';
            let dataLine = '';

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              }
              if (line.startsWith('data:')) {
                dataLine = line.slice(5).trim();
              }
            }

            if (!eventType || !dataLine) {
              return null;
            }

            try {
              const parsed = JSON.parse(dataLine) as ChatStreamEvent;
              if (parsed.type !== eventType) {
                return null;
              }
              return parsed;
            } catch {
              return null;
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';

            for (const chunk of chunks) {
              const event = parseEventBlock(chunk);
              if (!event) {
                continue;
              }
              observer.next(event);
            }
          }

          observer.complete();
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          observer.error(error);
        });

      return () => controller.abort();
    });
  }
}
