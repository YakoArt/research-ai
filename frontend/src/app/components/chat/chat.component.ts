import {
  AfterViewChecked,
  Component,
  OnDestroy,
  ElementRef,
  ViewChild,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownModule } from 'ngx-markdown';
import {
  AiService,
  ChatMessage,
  ChatStreamEvent,
  ChatStreamMeta,
  NewsItem,
} from '../../services/ai.service';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements AfterViewChecked, OnDestroy {
  @ViewChild('messagesEnd') messagesEnd!: ElementRef;

  messages = signal<ChatMessage[]>([]);
  input = signal('');
  loading = signal(false);
  error = signal('');
  waitingMs = signal(0);
  activeStage = signal('Ожидание запуска...');
  streamingText = signal('');

  private requestTimer: ReturnType<typeof setInterval> | null = null;
  private requestStartedAt = 0;
  private streamSub: Subscription | null = null;
  private latestMeta: ChatStreamMeta | null = null;

  constructor(private aiService: AiService) {}

  ngOnDestroy() {
    this.stopActiveStream();
    this.stopWaitTimer();
  }

  ngAfterViewChecked() {
    this.scrollToBottom();
  }

  send() {
    const text = this.input().trim();
    if (!text || this.loading()) return;

    this.messages.update(msgs => [...msgs, { role: 'user', content: text }]);
    this.input.set('');
    this.loading.set(true);
    this.error.set('');
    this.streamingText.set('');
    this.latestMeta = null;
    this.requestStartedAt = Date.now();
    this.activeStage.set('Подготавливаю запрос');
    this.startWaitTimer();

    const payloadMessages = this.messages();
    this.stopActiveStream();
    this.streamSub = this.aiService.chatStream(payloadMessages).subscribe({
      next: (event) => this.handleStreamEvent(event),
      error: () => this.runFallbackRequest(payloadMessages),
      complete: () => {
        if (this.loading()) {
          this.finishRequestState();
        }
      },
    });
  }

  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  getNewsItems(msg: ChatMessage): NewsItem[] | null {
    if (msg.news?.length) {
      return msg.news;
    }

    const parsed = this.tryParseJson(msg.content);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }

    const newsItems = parsed.filter((item): item is NewsItem => this.isNewsItem(item));
    if (newsItems.length !== parsed.length) {
      return null;
    }

    return newsItems;
  }

  getWarning(msg: ChatMessage): string | null {
    return msg.warning ?? null;
  }

  trackByNewsLink(_: number, item: NewsItem): string {
    return item.link;
  }

  formatWaitingSeconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }

  getMessageMeta(msg: ChatMessage): string[] {
    if (msg.role !== 'assistant') {
      return [];
    }

    const parts: string[] = [];

    if (typeof msg.responseMs === 'number') {
      parts.push(`Ожидание: ${this.formatWaitingSeconds(msg.responseMs)}с`);
    }

    if (typeof msg.newsCount === 'number') {
      parts.push(`Новостей: ${msg.newsCount}`);
    }

    parts.push(msg.isPartial ? 'Ответ частичный' : 'Ответ полный');

    if (msg.model) {
      parts.push(`Модель: ${msg.model}`);
    }

    if (msg.provider) {
      parts.push(`Источник: ${msg.provider}`);
    }

    return parts;
  }

  private handleStreamEvent(event: ChatStreamEvent) {
    if (event.type === 'status') {
      this.activeStage.set(event.message);
      return;
    }

    if (event.type === 'token') {
      this.streamingText.update((prev) => `${prev}${event.token}`);
      return;
    }

    if (event.type === 'meta') {
      this.latestMeta = event.meta;
      return;
    }

    if (event.type === 'error') {
      this.error.set(event.message ?? 'Ошибка соединения. Попробуйте ещё раз.');
      this.finishRequestState();
      return;
    }

    if (event.type === 'done') {
      this.messages.update((msgs) => [
        ...msgs,
        {
          role: event.payload.message.role ?? 'assistant',
          content: event.payload.message.content || this.streamingText(),
          news: event.payload.news,
          warning: event.payload.warning,
          isPartial: event.payload.isPartial,
          responseMs: event.payload.meta.responseMs,
          newsCount: event.payload.meta.newsCount,
          model: event.payload.meta.model,
          provider: event.payload.meta.provider,
          createdAt: new Date().toISOString(),
        },
      ]);
      this.finishRequestState();
    }
  }

  private runFallbackRequest(payloadMessages: ChatMessage[]) {
    this.activeStage.set('Поток недоступен, завершаю обычным запросом');
    this.stopActiveStream();

    this.aiService.chat(payloadMessages).subscribe({
      next: (res) => {
        const responseMs = Date.now() - this.requestStartedAt;
        this.messages.update((msgs) => [
          ...msgs,
          {
            role: res.message.role ?? 'assistant',
            content: res.message.content,
            news: res.news,
            warning: res.warning,
            isPartial: res.isPartial,
            responseMs,
            newsCount: res.news?.length ?? 0,
            model: this.latestMeta?.model ?? 'unknown',
            provider: this.latestMeta?.provider ?? 'fallback-http',
            createdAt: new Date().toISOString(),
          },
        ]);
        this.finishRequestState();
      },
      error: (err) => {
        const backendMessage = err?.error?.message;
        const normalizedMessage = Array.isArray(backendMessage)
          ? backendMessage.join(', ')
          : backendMessage;
        this.error.set(normalizedMessage ?? 'Ошибка соединения. Попробуйте ещё раз.');
        this.finishRequestState();
      },
    });
  }

  private startWaitTimer() {
    this.stopWaitTimer();
    this.waitingMs.set(0);
    this.requestTimer = setInterval(() => {
      this.waitingMs.set(Date.now() - this.requestStartedAt);
    }, 100);
  }

  private stopWaitTimer() {
    if (this.requestTimer) {
      clearInterval(this.requestTimer);
      this.requestTimer = null;
    }
  }

  private stopActiveStream() {
    this.streamSub?.unsubscribe();
    this.streamSub = null;
  }

  private finishRequestState() {
    this.stopWaitTimer();
    this.stopActiveStream();
    this.loading.set(false);
    this.streamingText.set('');
    this.activeStage.set('Готово');
  }

  private tryParseJson(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private isNewsItem(item: unknown): item is NewsItem {
    if (!item || typeof item !== 'object') {
      return false;
    }

    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate['title'] === 'string' &&
      typeof candidate['source'] === 'string' &&
      typeof candidate['date'] === 'string' &&
      typeof candidate['snippet'] === 'string' &&
      typeof candidate['link'] === 'string'
    );
  }

  private scrollToBottom() {
    try {
      this.messagesEnd.nativeElement.scrollIntoView({ behavior: 'smooth' });
    } catch {}
  }
}
