import axios from 'axios';

/**
 * Нормализованный результат новости, который возвращается в LLM.
 */
export interface SearchResult {
  title: string;
  source: string;
  date: string;
  snippet: string;
  link: string;
}

/**
 * Выполняет поиск новостей через SerpApi (Google News)
 * и возвращает ограниченный набор результатов.
 *
 * @param query - Поисковый запрос.
 * @returns Список найденных новостей в упрощенном формате.
 */
export async function search(query: string): Promise<SearchResult[]> {
  const res = await axios.get('https://serpapi.com/search.json', {
    params: {
      engine: 'google_news',
      q: query,
      hl: 'ru',
      gl: 'ru',
      num: 10,
      api_key: process.env.SERP_API_KEY,
    },
    timeout: 10000,
  });

  return (res.data.news_results || [])
    .slice(0, 5)
    .map((r: any) => ({
      title: r.title ?? 'Без заголовка',
      source: r.source?.name ?? r.source ?? 'Неизвестный источник',
      date: r.date ?? 'Дата не указана',
      snippet: r.snippet ?? '',
      link: r.link ?? '',
    }));
}

/**
 * Описание tools для OpenAI function calling.
 * Модель использует этот инструмент, когда нужно получить актуальные данные из интернета.
 */
export const tools = [
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Ищите в интернете актуальные новости и фактическую информацию.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Новостной поисковый запрос, например: "AI рынок России when:7d"',
          },
        },
        required: ['query'],
      },
    },
  },
];
