import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { beginLogin, finishLogin, getRequestSession, getSessionFromCookieHeader, isWorkspaceMember } from './auth.js';
import { config } from './config.js';
import { ensureIndexes, getDb } from './db.js';
import { createRedisSubscriber, getRedis } from './redis.js';
import {
  claimConversation,
  enqueueReply,
  getSnapshot,
  listConversations,
  listMessages,
  processWebhookEvent,
  recoverPendingWebhooks,
  resetApplicationData,
  setConversationStatus,
  startOutboxWorker,
  workspaceIds,
} from './store.js';

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true });

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (handler: AsyncHandler) => (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  void handler(request, response, next).catch(next);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graderAuthorized(request: Request): boolean {
  const token = request.header('x-grader-token');
  if (!token) return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(config.graderToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function verifyPigeonSignature(request: Request, body: Buffer): boolean {
  const signature = request.header('x-pigeon-signature');
  const match = signature?.match(/^t=(\d+),v1=([a-f0-9]{64})$/i);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Date.now() / 1000 - timestamp > 300) return false;
  const expected = createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${match[1]}.${body.toString('utf8')}`)
    .digest();
  const received = Buffer.from(match[2], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

app.get('/healthz', (_request, response) => {
  response.status(200).json({ ok: true });
});

app.post(
  '/webhooks/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!verifyPigeonSignature(request, rawBody)) {
      response.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      response.status(400).json({ error: 'invalid JSON' });
      return;
    }
    if (!isRecord(payload)) {
      response.status(400).json({ error: 'invalid event body' });
      return;
    }
    const eventId = request.header('x-pigeon-event-id') ?? payload.id;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      response.status(400).json({ error: 'event id is required' });
      return;
    }
    if (typeof payload.type !== 'string' || !['message.inbound', 'message.status'].includes(payload.type)) {
      response.status(200).json({ ok: true });
      return;
    }
    if (typeof payload.workspace !== 'string' || !workspaceIds.has(payload.workspace)) {
      response.status(200).json({ ok: true });
      return;
    }

    const events = (await getDb()).collection<{
      _id: string;
      body: Record<string, unknown>;
      receivedAt: Date;
      processed: boolean;
    }>('webhook_events');
    let savedEvent: {
      _id: string;
      body: Record<string, unknown>;
      receivedAt: Date;
      processed: boolean;
    } | null;
    try {
      savedEvent = {
        _id: eventId,
        body: payload,
        receivedAt: new Date(),
        processed: false,
      };
      await events.insertOne(savedEvent);
    } catch (error) {
      if (!isRecord(error) || error.code !== 11000) throw error;
      savedEvent = await events.findOne({ _id: eventId });
    }
    if (savedEvent && !savedEvent.processed) {
      await processWebhookEvent(savedEvent);
      await events.updateOne({ _id: eventId, processed: false }, { $set: { processed: true } });
    }
    response.status(200).json({ ok: true });
  }),
);

app.use(express.json({ limit: '1mb' }));

app.get('/auth/login', asyncHandler(async (_request, response) => {
  await beginLogin(response);
}));

app.get('/auth/callback', asyncHandler(async (request, response) => {
  await finishLogin(request, response);
}));

app.get('/api/me', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  response.json({ sub: session.sub, workspaces: session.workspaces });
}));

app.get('/api/conversations', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  const workspace = typeof request.query.workspace === 'string' ? request.query.workspace : '';
  if (!isWorkspaceMember(session, workspace)) {
    response.status(403).json({ error: 'workspace access denied' });
    return;
  }
  const requestedLimit = Number(request.query.limit ?? 30);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    response.status(400).json({ error: 'limit must be a positive integer' });
    return;
  }
  const limit = Math.min(requestedLimit, 50);
  const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined;
  response.json(await listConversations(workspace, limit, cursor));
}));

app.get('/api/conversations/:contact/messages', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  const workspace = typeof request.query.workspace === 'string' ? request.query.workspace : '';
  if (!isWorkspaceMember(session, workspace)) {
    response.status(403).json({ error: 'workspace access denied' });
    return;
  }
  response.json({ messages: await listMessages(workspace, request.params.contact) });
}));

app.post('/api/conversations/:contact/reply', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  const { workspace, text, client_ref: clientRef } = request.body ?? {};
  if (typeof workspace !== 'string' || !isWorkspaceMember(session, workspace)) {
    response.status(403).json({ error: 'workspace access denied' });
    return;
  }
  if (typeof text !== 'string' || !text.trim() || typeof clientRef !== 'string' || !clientRef.trim()) {
    response.status(400).json({ error: 'text and client_ref are required' });
    return;
  }
  await enqueueReply(workspace, request.params.contact, text, clientRef);
  response.status(202).json({ status: 'queued', client_ref: clientRef });
}));

app.post('/api/conversations/:contact/claim', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  const workspace = request.body?.workspace;
  if (typeof workspace !== 'string' || !isWorkspaceMember(session, workspace)) {
    response.status(403).json({ error: 'workspace access denied' });
    return;
  }
  const claimed = await claimConversation(workspace, request.params.contact, session.sub);
  response.status(claimed ? 200 : 409).json({ assignee: claimed ? session.sub : null });
}));

app.patch('/api/conversations/:contact', asyncHandler(async (request, response) => {
  const session = await getRequestSession(request);
  if (!session) {
    response.status(401).json({ error: 'authentication required' });
    return;
  }
  const workspace = request.body?.workspace;
  const status = request.body?.status;
  if (typeof workspace !== 'string' || !isWorkspaceMember(session, workspace)) {
    response.status(403).json({ error: 'workspace access denied' });
    return;
  }
  if (status !== 'open' && status !== 'closed') {
    response.status(400).json({ error: 'status must be open or closed' });
    return;
  }
  await setConversationStatus(workspace, request.params.contact, status);
  response.status(200).json({ status });
}));

app.use('/__grader', (request, response, next) => {
  if (!graderAuthorized(request)) {
    response.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

app.post('/__grader/reset', asyncHandler(async (_request, response) => {
  await resetApplicationData();
  response.status(200).json({ ok: true });
}));

app.get('/__grader/snapshot', asyncHandler(async (_request, response) => {
  response.json(await getSnapshot());
}));

app.post('/__grader/reply', asyncHandler(async (request, response) => {
  const { workspace, contact, text, client_ref: clientRef } = request.body ?? {};
  if (typeof workspace !== 'string' || !workspaceIds.has(workspace)) {
    response.status(400).json({ error: 'unknown workspace' });
    return;
  }
  if (typeof contact !== 'string' || !contact || typeof text !== 'string' || !text.trim()
    || typeof clientRef !== 'string' || !clientRef.trim()) {
    response.status(400).json({ error: 'contact, text and client_ref are required' });
    return;
  }
  await enqueueReply(workspace, contact, text, clientRef);
  response.status(202).json({ status: 'queued', client_ref: clientRef });
}));

app.post('/__grader/claim', asyncHandler(async (request, response) => {
  const { workspace, contact, agent } = request.body ?? {};
  if (typeof workspace !== 'string' || !workspaceIds.has(workspace)) {
    response.status(400).json({ error: 'unknown workspace' });
    return;
  }
  if (typeof contact !== 'string' || !contact || typeof agent !== 'string' || !agent) {
    response.status(400).json({ error: 'contact and agent are required' });
    return;
  }
  const claimed = await claimConversation(workspace, contact, agent);
  response.status(claimed ? 200 : 409).json({ assignee: claimed ? agent : null });
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error('Request failed:', error);
  if (response.headersSent) return;
  if (isRecord(error) && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    response.status(error.status).json({ error: 'invalid request' });
    return;
  }
  response.status(500).json({ error: 'internal server error' });
});

function rejectUpgrade(socket: Duplex, status: number, label: string): void {
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function attachWorkspaceSocket(socket: WebSocket, workspace: string, after?: number): Promise<void> {
  const subscriber = createRedisSubscriber();
  const waiting: Array<Record<string, unknown>> = [];
  let replaying = after !== undefined;
  let lastSent = after ?? 0;
  const send = (frame: Record<string, unknown>) => {
    const seq = Number(frame.seq);
    if (seq <= lastSent || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
    lastSent = seq;
  };
  subscriber.on('message', (_channel, content) => {
    try {
      const frame = JSON.parse(content) as Record<string, unknown>;
      if (replaying) waiting.push(frame);
      else send(frame);
    } catch (error) {
      console.error('Ignoring malformed workspace event:', error);
    }
  });
  await subscriber.subscribe(`sb:events:${workspace}`);
  if (after !== undefined) {
    const replay = await (await getDb()).collection('stream_events')
      .find({ workspace, seq: { $gt: after } })
      .sort({ seq: 1 })
      .toArray();
    for (const event of replay) send(event.frame as Record<string, unknown>);
  }
  replaying = false;
  waiting.sort((a, b) => Number(a.seq) - Number(b.seq));
  for (const frame of waiting) send(frame);

  const cleanup = () => {
    void subscriber.unsubscribe(`sb:events:${workspace}`)
      .then(() => subscriber.quit())
      .catch((error: unknown) => console.error('Could not close WebSocket subscriber:', error));
  };
  socket.once('close', cleanup);
  socket.once('error', cleanup);
}

server.on('upgrade', (request: IncomingMessage, socket: Duplex, head) => {
  const url = new URL(request.url ?? '/', `http://localhost:${config.port}`);
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  const workspace = url.searchParams.get('workspace');
  const afterText = url.searchParams.get('after');
  const after = afterText === null ? undefined : Number(afterText);
  if (!workspace || !workspaceIds.has(workspace)
    || (after !== undefined && (!Number.isSafeInteger(after) || after < 0))) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }
  void getSessionFromCookieHeader(request.headers.cookie)
    .then((session) => {
      if (!session) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      if (!isWorkspaceMember(session, workspace)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        void attachWorkspaceSocket(webSocket, workspace, after)
          .catch((error: unknown) => {
            console.error('Could not attach workspace WebSocket:', error);
            webSocket.close(1011, 'Unable to attach workspace stream');
          });
      });
    })
    .catch((error: unknown) => {
      console.error('WebSocket authentication failed:', error);
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
});

async function start(): Promise<void> {
  await ensureIndexes();
  await getRedis().ping();
  startOutboxWorker();
  setInterval(() => {
    recoverPendingWebhooks().catch((error: unknown) => console.error('Webhook recovery failed:', error));
  }, 1000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });
  console.log(`server on http://localhost:${config.port}`);
}

start().catch((error: unknown) => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});
