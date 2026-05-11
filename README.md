# Research Assistant Lite

AI-ассистент с поддержкой web-поиска (SerpApi).

Проект полностью создан с помощью Cursor в учебных целях.
Для запуска требуется локально развернутая LLM (OpenAI-compatible API).
Текущий проект запускался с использованием LM Studio и модели `google/gemma-4-e4b`.

## Стек

- **Backend**: NestJS 11, OpenAI SDK, SerpApi
- **Frontend**: Angular 21, ngx-markdown

## Архитектура

- `frontend` (Angular): UI чата, ввод запроса, отображение ответа в markdown
- `backend` (NestJS): REST API, оркестрация запросов к LLM и web-поиску
- Внешние сервисы: OpenAI для генерации ответа, SerpApi для получения свежих данных из web

## Принципы работы приложения

1. Пользователь отправляет запрос из веб-интерфейса.
2. Backend анализирует запрос и при необходимости выполняет web-поиск через SerpApi.
3. Контекст (запрос + результаты поиска) передается в OpenAI.
4. Сформированный ответ возвращается в frontend и показывается пользователю в чате.

## Запуск

Перед запуском backend убедись, что локальная LLM уже поднята и доступна по API.

### 1. Backend

```bash
cd backend
cp .env.example .env
# Заполни .env своими ключами
npm install
npm run start:dev
# → http://localhost:3000
```

### 2. Frontend

```bash
cd frontend
npm install
ng serve
# → http://localhost:4200
```

## Переменные окружения (backend/.env)


| Переменная     | Описание                   |
| -------------- | -------------------------- |
| OPENAI_API_KEY | Ключ OpenAI API            |
| SERP_API_KEY   | Ключ SerpApi (serpapi.com) |


