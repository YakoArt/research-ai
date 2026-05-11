import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiService } from './ai.service';
import { ChatDto, ChatStreamEvent } from './dto/chat.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  async chat(@Body() dto: ChatDto) {
    return this.aiService.chat(dto.messages);
  }

  @Post('chat/stream')
  async streamChat(
    @Body() dto: ChatDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const writeEvent = (event: ChatStreamEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    req.on('close', () => {
      res.end();
    });

    try {
      await this.aiService.chatStream(dto.messages, writeEvent);
      res.end();
    } catch {
      writeEvent({
        type: 'error',
        message: 'AI service is unavailable. Please try again later.',
      });
      res.end();
    }
  }
}
