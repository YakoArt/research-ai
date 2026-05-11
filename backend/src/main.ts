import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationError } from 'class-validator';
import { AppModule } from './app.module';

function collectValidationMessages(errors: ValidationError[]): string[] {
  const messages: string[] = [];

  for (const error of errors) {
    if (error.constraints) {
      messages.push(...Object.values(error.constraints));
    }
    if (error.children?.length) {
      messages.push(...collectValidationMessages(error.children));
    }
  }

  return messages;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Validation');

  app.enableCors({
    origin: 'http://localhost:4200',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => {
        const messages = collectValidationMessages(errors);
        logger.warn(
          `Validation failed: ${messages.slice(0, 3).join(' | ') || 'Unknown validation error'}`,
        );
        return new BadRequestException(messages);
      },
    }),
  );

  await app.listen(3000);
  console.log('Backend running on http://localhost:3000');
}

bootstrap();
