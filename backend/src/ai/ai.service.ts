import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';
import { search, SearchResult, tools } from './tools/search.tool';
import { SYSTEM_PROMPT } from './prompts/system.prompt';
import {
  AiStatusStage,
  ChatDonePayload,
  ChatStreamEvent,
} from './dto/chat.dto';

/**
 * Сервис интеграции с LLM через OpenAI-совместимый API.
 * Поддерживает tool-calling для получения актуальной информации из интернета.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly model = process.env.LLM_MODEL ?? 'gpt-4.1-mini';

  private readonly openai = new OpenAI({
    apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY,
    ...(process.env.LLM_BASE_URL && { baseURL: process.env.LLM_BASE_URL }),
  });

  private readonly targetNewsCount = 10;

  private readonly maxToolRounds = 5;

  private readonly maxSnippetLength = 320;

  private readonly fallbackWarning =
    'Не удалось собрать полный список новостей в пределах лимита tool-вызовов.';

  private readonly providerName = process.env.LLM_BASE_URL
    ? 'local-openai-compatible'
    : 'openai';

  /**
   * Нормализует произвольный массив объектов новостей к внутреннему формату.
   * Отбрасывает невалидные элементы и записи без ссылки.
   *
   * @param rawItems - Сырые данные, полученные от модели или инструмента.
   * @returns Массив нормализованных новостей.
   */
  private normalizeNewsItems(rawItems: unknown): SearchResult[] {
    if (!Array.isArray(rawItems)) {
      return [];
    }

    return rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object',
      )
      .map((item) => ({
        title:
          typeof item['title'] === 'string' && item['title'].trim()
            ? item['title'].trim()
            : 'Без заголовка',
        source:
          typeof item['source'] === 'string' && item['source'].trim()
            ? item['source'].trim()
            : 'Неизвестный источник',
        date:
          typeof item['date'] === 'string' && item['date'].trim()
            ? item['date'].trim()
            : 'Дата не указана',
        snippet:
          typeof item['snippet'] === 'string'
            ? item['snippet'].trim().slice(0, this.maxSnippetLength)
            : '',
        link: typeof item['link'] === 'string' ? item['link'].trim() : '',
      }))
      .filter((item) => item.link.length > 0);
  }

  /**
   * Удаляет дубликаты новостей и ограничивает итоговый список целевым размером.
   * Дубликаты определяются по ссылке, а если она отсутствует — по составному ключу.
   *
   * @param items - Исходный список новостей.
   * @returns Уникальный список новостей с учетом лимита.
   */
  private deduplicateAndLimitNews(items: SearchResult[]): SearchResult[] {
    const unique = new Map<string, SearchResult>();

    for (const item of items) {
      const key = item.link || `${item.title}|${item.source}|${item.date}`;
      if (!unique.has(key)) {
        unique.set(key, item);
      }
    }

    return Array.from(unique.values()).slice(0, this.targetNewsCount);
  }

  /**
   * Пытается извлечь структурированные новости из текстового ответа ассистента.
   *
   * @param content - Содержимое сообщения ассистента.
   * @returns Массив новостей или пустой массив, если парсинг не удался.
   */
  private parseAssistantNewsContent(content: string | null): SearchResult[] {
    if (!content) {
      return [];
    }

    try {
      const parsed = JSON.parse(content) as string;
      return this.normalizeNewsItems(parsed);
    } catch {
      return [];
    }
  }

  /**
   * Формирует текст сообщения ассистента из массива новостей в JSON-формате.
   *
   * @param news - Список новостей для выдачи клиенту.
   * @returns Строка с сериализованными данными новостей.
   */
  private buildAssistantMessageFromNews(news: SearchResult[]): string {
    return JSON.stringify(news);
  }

  /**
   * Выполняет вызов инструмента, запрошенный моделью, и возвращает результат
   * в формате сообщения role=tool для продолжения диалога.
   *
   * @param toolCall - Описание вызова инструмента от модели.
   * @returns Идентификатор вызова и сериализованный результат работы инструмента.
   */
  private async executeToolCall(
    toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
  ): Promise<{ tool_call_id: string; content: string }> {
    if (toolCall.type !== 'function') {
      return {
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: `Unsupported tool call type: ${toolCall.type}`,
        }),
      };
    }

    const functionName = toolCall.function?.name;
    const rawArgs = toolCall.function?.arguments ?? '{}';

    if (functionName !== 'search') {
      return {
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: `Unsupported tool: ${functionName ?? 'unknown'}`,
        }),
      };
    }

    try {
      const parsed = JSON.parse(rawArgs) as { query?: string };
      const query = parsed.query?.trim();

      if (!query) {
        return {
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: 'Missing required argument: query',
          }),
        };
      }

      const result = await search(query);
      this.logger.log(`Search executed: "${query}"`);

      return {
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      };
    } catch (searchErr) {
      this.logger.error('Search tool failed', searchErr);
      return {
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: 'Search unavailable, answer from model knowledge.',
        }),
      };
    }
  }

  /**
   * Обрабатывает пользовательские сообщения и возвращает ответ ассистента.
   * При необходимости модель может вызывать инструменты (например, интернет-поиск)
   * в несколько итераций, после чего формируется финальный ответ.
   *
   * @param userMessages - История сообщений пользователя/клиента.
   * @returns Сообщение ассистента в формате Chat Completions API.
   */
  async chat(userMessages: { role: string; content: string }[]) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...userMessages,
    ] as OpenAI.Chat.ChatCompletionMessageParam[];

    this.logger.log(
      `Using model: ${this.model}, baseURL: ${process.env.LLM_BASE_URL ?? 'OpenAI default'}`,
    );

    try {
      let collectedNews: SearchResult[] = [];

      for (let round = 0; round < this.maxToolRounds; round += 1) {
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          tools: tools as OpenAI.Chat.ChatCompletionTool[],
          tool_choice: 'auto',
        });

        const assistantMsg = completion.choices[0].message;
        messages.push(assistantMsg);

        if (!assistantMsg.tool_calls?.length) {
          const assistantNews = this.parseAssistantNewsContent(
            assistantMsg.content,
          );
          const mergedNews = this.deduplicateAndLimitNews([
            ...collectedNews,
            ...assistantNews,
          ]);
          const hasStructuredNews = mergedNews.length > 0;
          const isPartial =
            hasStructuredNews && mergedNews.length < this.targetNewsCount;

          return {
            message: {
              role: assistantMsg.role ?? 'assistant',
              content: hasStructuredNews
                ? this.buildAssistantMessageFromNews(mergedNews)
                : (assistantMsg.content ?? ''),
            },
            news: hasStructuredNews ? mergedNews : undefined,
            isPartial,
            warning: isPartial
              ? `Показаны ${mergedNews.length} из ${this.targetNewsCount} новостей.`
              : undefined,
          };
        }

        for (const toolCall of assistantMsg.tool_calls) {
          const toolResult = await this.executeToolCall(toolCall);
          try {
            const parsedToolContent = JSON.parse(toolResult.content) as string;
            const normalized = this.normalizeNewsItems(parsedToolContent);
            if (normalized.length > 0) {
              collectedNews = this.deduplicateAndLimitNews([
                ...collectedNews,
                ...normalized,
              ]);
            }
          } catch {
            // no-op: tool might return an error payload, keep going
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolResult.tool_call_id,
            content: toolResult.content,
          });
        }
      }

      const limitedNews = this.deduplicateAndLimitNews(collectedNews);
      if (limitedNews.length > 0) {
        return {
          message: {
            role: 'assistant',
            content: this.buildAssistantMessageFromNews(limitedNews),
          },
          news: limitedNews,
          isPartial: limitedNews.length < this.targetNewsCount,
          warning: `Показаны ${limitedNews.length} из ${this.targetNewsCount} новостей. ${this.fallbackWarning}`,
        };
      }

      return {
        message: {
          role: 'assistant',
          content:
            'Не удалось завершить цепочку tool-вызовов за допустимое число итераций.',
        },
        news: [],
        isPartial: false,
        warning: this.fallbackWarning,
      };
    } catch (err) {
      this.logger.error('LLM request failed', err);
      throw new InternalServerErrorException(
        'AI service is unavailable. Please try again later.',
      );
    }
  }

  /**
   * Выполняет потоковую обработку запроса чата с промежуточными статусами и токенами.
   * Внутри может запускать tool-calling, как и обычный `chat`, но отправляет события
   * по мере готовности данных.
   *
   * @param userMessages - История сообщений пользователя/клиента.
   * @param emit - Callback для отправки событий стрима в клиент.
   * @returns Promise, завершающийся после отправки финального события.
   */
  async chatStream(
    userMessages: { role: string; content: string }[],
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    const provider = this.providerName;

    const status = (stage: AiStatusStage, message: string) => {
      emit({ type: 'status', stage, message });
    };

    const emitTokenizedText = async (text: string) => {
      if (!text) {
        return;
      }

      const chunkSize = 24;
      for (let i = 0; i < text.length; i += chunkSize) {
        emit({
          type: 'token',
          token: text.slice(i, i + chunkSize),
        });
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };

    const emitDone = async (payload: Omit<ChatDonePayload, 'meta'>) => {
      const responseMs = Date.now() - startedAt;
      const meta = {
        responseMs,
        isPartial: payload.isPartial,
        newsCount: payload.news?.length ?? 0,
        model: this.model,
        provider,
      };

      emit({ type: 'meta', meta });
      status('finalizing', 'Формирую финальный ответ');
      await emitTokenizedText(payload.message.content);
      emit({
        type: 'done',
        payload: {
          ...payload,
          meta,
        },
      });
    };

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...userMessages,
    ] as OpenAI.Chat.ChatCompletionMessageParam[];

    this.logger.log(
      `Using model: ${this.model}, baseURL: ${process.env.LLM_BASE_URL ?? 'OpenAI default'}`,
    );

    try {
      let collectedNews: SearchResult[] = [];
      status('preparing', 'Подготавливаю запрос');

      for (let round = 0; round < this.maxToolRounds; round += 1) {
        status('calling_model', `Обращаюсь к модели (шаг ${round + 1})`);
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          tools: tools as OpenAI.Chat.ChatCompletionTool[],
          tool_choice: 'auto',
        });

        const assistantMsg = completion.choices[0].message;
        messages.push(assistantMsg);

        if (!assistantMsg.tool_calls?.length) {
          const assistantNews = this.parseAssistantNewsContent(
            assistantMsg.content,
          );
          const mergedNews = this.deduplicateAndLimitNews([
            ...collectedNews,
            ...assistantNews,
          ]);
          const hasStructuredNews = mergedNews.length > 0;
          const isPartial =
            hasStructuredNews && mergedNews.length < this.targetNewsCount;

          await emitDone({
            message: {
              role: assistantMsg.role ?? 'assistant',
              content: hasStructuredNews
                ? this.buildAssistantMessageFromNews(mergedNews)
                : (assistantMsg.content ?? ''),
            },
            news: hasStructuredNews ? mergedNews : undefined,
            isPartial,
            warning: isPartial
              ? `Показаны ${mergedNews.length} из ${this.targetNewsCount} новостей.`
              : undefined,
          });
          return;
        }

        status('fetching_news', 'Выполняю поиск по источникам');
        for (const toolCall of assistantMsg.tool_calls) {
          const toolResult = await this.executeToolCall(toolCall);
          try {
            const parsedToolContent = JSON.parse(toolResult.content) as string;
            const normalized = this.normalizeNewsItems(parsedToolContent);
            if (normalized.length > 0) {
              collectedNews = this.deduplicateAndLimitNews([
                ...collectedNews,
                ...normalized,
              ]);
            }
          } catch {
            // no-op: tool might return an error payload, keep going
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolResult.tool_call_id,
            content: toolResult.content,
          });
        }
      }

      const limitedNews = this.deduplicateAndLimitNews(collectedNews);
      if (limitedNews.length > 0) {
        await emitDone({
          message: {
            role: 'assistant',
            content: this.buildAssistantMessageFromNews(limitedNews),
          },
          news: limitedNews,
          isPartial: limitedNews.length < this.targetNewsCount,
          warning: `Показаны ${limitedNews.length} из ${this.targetNewsCount} новостей. ${this.fallbackWarning}`,
        });
        return;
      }

      await emitDone({
        message: {
          role: 'assistant',
          content:
            'Не удалось завершить цепочку tool-вызовов за допустимое число итераций.',
        },
        news: [],
        isPartial: false,
        warning: this.fallbackWarning,
      });
    } catch (err) {
      this.logger.error('LLM stream request failed', err);
      emit({
        type: 'error',
        message: 'AI service is unavailable. Please try again later.',
      });
      throw new InternalServerErrorException(
        'AI service is unavailable. Please try again later.',
      );
    }
  }
}
