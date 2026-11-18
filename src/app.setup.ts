import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
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
  // Behind an AWS load balancer the client IP arrives in X-Forwarded-For.
  // Trusting one proxy hop makes req.ip (and so rate limiting) see the real client.
  (app as NestExpressApplication).set('trust proxy', 1);

  // Security headers. CSP is off because this service only serves JSON (and the Swagger page).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());

  // One structured log line per request with a request id, so a request can be traced
  // across instances in CloudWatch. Honour an incoming id from the load balancer if present.
  const http = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', id);
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/health')) return;
      http.log(
        JSON.stringify({ id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - start }),
      );
    });
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip fields that aren't in the DTO
      forbidNonWhitelisted: true, // ...and reject the request if any were sent
      transform: true,
    }),
  );
  // In production, only the web app's own origin may call the API from a browser.
  // CORS_ORIGINS is a comma-separated list, e.g. https://app.yourdomain.com
  const origins = app.get(ConfigService).get<string>('CORS_ORIGINS');
  app.enableCors({ origin: origins ? origins.split(',').map((o) => o.trim()) : true });
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
