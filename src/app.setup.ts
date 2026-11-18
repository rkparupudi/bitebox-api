import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub. Without it, an event emitted on API instance A
 * never reaches a client connected to instance B, so real-time breaks the moment you scale out.
 */
class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  async connect(url: string) {
    const pub = new Redis(url);
    const sub = pub.duplicate();
    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }

  async dispose() {
    await super.dispose();
    await Promise.all(this.clients.map((c) => c.quit()));
  }
}

/** Shared by main.ts and the e2e tests, so tests run the app exactly as production does. */
export async function configureApp(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip fields that aren't in the DTO
      forbidNonWhitelisted: true, // ...and reject the request if any were sent
      transform: true,
    }),
  );
  app.enableCors();
  app.enableShutdownHooks();

  const adapter = new RedisIoAdapter(app);
  await adapter.connect(app.get(ConfigService).getOrThrow<string>('REDIS_URL'));
  app.useWebSocketAdapter(adapter);

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('BiteBridge API')
      .setDescription('Food ordering and delivery backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);
}
