import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';

export class MessageDto {
  @IsString()
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

export class ChatDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[];
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
  message: MessageDto;
  warning?: string;
  isPartial: boolean;
  news?: Array<{
    title: string;
    source: string;
    date: string;
    snippet: string;
    link: string;
  }>;
  meta: ChatStreamMeta;
}

export type ChatStreamEvent =
  | { type: 'status'; stage: AiStatusStage; message: string }
  | { type: 'token'; token: string }
  | { type: 'meta'; meta: ChatStreamMeta }
  | { type: 'done'; payload: ChatDonePayload }
  | { type: 'error'; message: string };
