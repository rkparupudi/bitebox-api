import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // rawBody: Stripe's webhook signature is computed over the exact bytes it sent.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
