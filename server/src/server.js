import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import morgan from 'morgan';
import { config } from './config.js';
import {
  apiLimiter,
  corsMw,
  errorHandler,
  helmetMw,
  notFound,
  originGuard,
  sanitizeMw,
} from './security.js';
import { startJobs } from './jobs.js';
import { startPdfEngine, stopPdfEngine } from './pdf.js';
import authRoutes from './routes/auth.js';
import masterRoutes, { seedDefaultCourse } from './routes/master.js';
import studentRoutes from './routes/students.js';
import paymentRoutes from './routes/payments.js';
import admitCardRoutes from './routes/admitCards.js';

function ensureStorageDirs() {
  for (const dir of [config.paths.pdfCache, config.paths.csvTemp, config.paths.exports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  ensureStorageDirs();

  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 10 });
  console.log('[db] MongoDB connected');
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

  await seedDefaultCourse();
  await startJobs();
  await startPdfEngine();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmetMw);
  app.use(corsMw);
  app.use(morgan(config.isProd ? 'combined' : 'dev'));
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, res, buf) => {
        // Razorpay webhook signature needs the untouched raw body.
        if (req.originalUrl.startsWith('/api/payments/webhook')) req.rawBody = buf;
      },
    })
  );
  app.use(cookieParser());
  app.use(sanitizeMw);
  app.use(originGuard);

  app.get('/api/health', (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.status(dbReady ? 200 : 503).json({ success: dbReady, status: dbReady ? 'ok' : 'db_down' });
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/master', masterRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/admit-cards', admitCardRoutes);

  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`[server] Running on http://localhost:${config.port} (${config.env})`);
  });

  server.on('error', (err) => {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`[server] ${signal} received, shutting down...`);
    server.close(async () => {
      await stopPdfEngine();
      await mongoose.connection.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

main().catch((err) => {
  console.error('[startup] Failed:', err.message);
  process.exit(1);
});