import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OAuth2Client } from 'google-auth-library';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class ExecutionContext {
  constructor() {
    this.pending = new Set();
    this.errors = [];
  }

  waitUntil(promise) {
    const tracked = Promise.resolve(promise).catch((error) => {
      this.errors.push(error);
      console.error('[Background]', error);
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async drain() {
    while (this.pending.size) {
      // Background work may enqueue additional work.
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(this.pending);
    }
    if (this.errors.length) throw new AggregateError(this.errors, 'Background work failed');
  }
}

export function googleTokenVerifier({ serviceUrl, serviceAccount, client = new OAuth2Client() }) {
  return async (request) => {
    const match = request.headers.get('authorization')?.match(/^Bearer (.+)$/i);
    if (!match) return false;
    try {
      const ticket = await client.verifyIdToken({
        idToken: match[1],
        audience: serviceUrl,
      });
      const payload = ticket.getPayload();
      return payload?.email_verified === true && payload.email === serviceAccount;
    } catch (error) {
      console.warn('[InternalAuth] Invalid Google identity token:', error.message);
      return false;
    }
  };
}

export function blockCloudflareRequests(originalFetch = globalThis.fetch) {
  return (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const blocked = ['cloudflare.com', 'workers.dev'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    if (blocked) throw new Error(`Cloudflare requests are disabled on the Google backend: ${url.hostname}`);
    return originalFetch(input, init);
  };
}

export function createGoogleServer({
  handler,
  env,
  verifyInternal,
  deliverTask,
  scheduled,
}) {
  return createServer(async (incoming, outgoing) => {
    const ctx = new ExecutionContext();
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          outgoing.writeHead(413, { 'Content-Type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'Request body exceeds 2 MiB' }));
          return;
        }
        chunks.push(chunk);
      }

      const origin = env.SERVICE_URL || `http://localhost:${env.PORT || 8080}`;
      const headers = new Headers();
      Object.entries(incoming.headers).forEach(([key, value]) => {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      });
      // Cloud Run appends the immediate client's address; do not trust a supplied CF header.
      headers.set(
        'cf-connecting-ip', (
          incoming.headers['x-forwarded-for']?.split(',').at(-1)?.trim()
        || incoming.socket.remoteAddress || 'unknown'
        ),
      );
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method,
        headers,
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      });
      const { pathname } = new URL(request.url);
      let response;
      if (pathname === '/healthz' || pathname === '/health') {
        response = Response.json({ status: 'ok', platform: 'google-cloud' });
      } else if (pathname.startsWith('/internal/')) {
        if (!await verifyInternal(request)) {
          response = Response.json({ error: 'Google service-account authentication required' }, { status: 401 });
        } else if (pathname === '/internal/tasks/eval' && request.method === 'POST') {
          await deliverTask(request, env, ctx);
          await ctx.drain();
          response = Response.json({ ok: true });
        } else if (pathname === '/internal/scheduled' && request.method === 'POST') {
          await scheduled(env, ctx);
          await ctx.drain();
          response = Response.json({ ok: true });
        } else {
          response = Response.json({ error: 'Not found' }, { status: 404 });
        }
      } else {
        response = await handler(request, env, ctx);
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        await pipeline(Readable.fromWeb(response.body), outgoing, { end: false });
      }
      await ctx.drain();
      await env.ANALYTICS?.flush?.();
      outgoing.end();
    } catch (error) {
      console.error('[HTTP]', error);
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'Google backend request failed' }));
      } else if (!outgoing.writableEnded) {
        outgoing.destroy(error);
      }
    }
  });
}
