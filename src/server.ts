import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerBudgetTool, fetchBudget } from '@riseup-oss/mcp/dist/tools/budget.js';
import { registerTransactionsTool, fetchTransactions } from '@riseup-oss/mcp/dist/tools/transactions.js';
import type { RiseupClientConfig } from '@riseup-oss/mcp/dist/client.js';
import { Sealer, StatelessProvider, parseKey } from './oauth.js';

const PORT = Number(process.env.PORT ?? 8787);
const API_BASE = 'https://input.riseup.co.il';
const PAT_RE = /^riseup_pat_[A-Za-z0-9_-]{20,100}$/;
const MAX_BODY_BYTES = 1_000_000;

const ALLOWED_HASHES = (process.env.ALLOWED_PAT_SHA256 ?? '')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  .map((h) => Buffer.from(h, 'hex'));

function patAllowed(pat: string): boolean {
  if (ALLOWED_HASHES.length === 0) return true;
  const digest = createHash('sha256').update(pat).digest();
  return ALLOWED_HASHES.some((h) => h.length === digest.length && timingSafeEqual(h, digest));
}

function extractPat(url: URL): string | null {
  const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
  let pat: string | null;
  try {
    pat = m ? decodeURIComponent(m[1])
      : url.pathname.replace(/\/$/, '') === '/mcp' ? url.searchParams.get('pat') : null;
  } catch {
    return null; // malformed percent-encoding
  }
  return pat && PAT_RE.test(pat) ? pat : null;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const handlers: Record<string, (args: any, cfg: RiseupClientConfig) => Promise<ToolResult>> = {
  get_budget: async ({ date }, cfg) => json(await fetchBudget(date, cfg)),
  get_transactions: async ({ cashflowMonth, transactionDate, businessName }, cfg) => {
    if (!cashflowMonth && !transactionDate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide cashflowMonth ("YYYY-MM") or transactionDate ("YYYY-MM-DD"); businessName alone is not enough.' }] };
    }
    return json(await fetchTransactions({ cashflowMonth, transactionDate, businessName }, cfg));
  },
};

// Reuse upstream tool names/descriptions/schemas, but swap in per-request handlers.
function buildServer(cfg: RiseupClientConfig): McpServer {
  const server = new McpServer({ name: 'riseup-remote', version: '0.1.0' });
  const shim = {
    registerTool(name: string, toolConfig: unknown, _envHandler: unknown) {
      const h = handlers[name];
      if (!h) { console.warn(`Skipping upstream tool "${name}": no remote handler yet.`); return; }
      (server.registerTool as any)(name, toolConfig, (args: unknown) => h(args, cfg));
    },
  } as unknown as McpServer;
  registerBudgetTool(shim);
  registerTransactionsTool(shim);
  return server;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleMcp(req: express.Request, res: express.Response, pat: string): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, 'method not allowed');
  let body: unknown;
  try { body = await readJson(req); } catch { return send(res, 400, 'bad request'); }
  const server = buildServer({ pat, apiBase: API_BASE });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('request failed:', (e as Error).message);
    if (!res.headersSent) send(res, 500, 'internal error');
  }
}

// OAuth mode (token in Authorization header) is enabled when both are set.
const PUBLIC_URL = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '');
const ENC_KEY = process.env.TOKEN_ENCRYPTION_KEY?.trim();
if (!!PUBLIC_URL !== !!ENC_KEY) {
  console.error('PUBLIC_URL and TOKEN_ENCRYPTION_KEY must be set together (or both left empty).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // one reverse proxy (cloudflared / platform router) in front; used for rate limiting
app.get('/healthz', (_req, res) => send(res, 200, 'ok'));

let bearer: express.RequestHandler | undefined;
if (PUBLIC_URL && ENC_KEY) {
  const provider = new StatelessProvider(new Sealer(parseKey(ENC_KEY)), patAllowed);
  const resourceUrl = new URL(`${PUBLIC_URL}/mcp`);
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceServerUrl: resourceUrl,
    resourceName: 'RiseUp',
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  app.post('/consent',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res) => provider.handleConsent(req, res, PAT_RE));
  bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
}

app.use(async (req, res, next) => {
  const url = new URL(req.originalUrl, 'http://localhost'); // never log this
  if (!url.pathname.startsWith('/mcp')) return next();
  const inUrl = url.pathname.replace(/\/$/, '') !== '/mcp' || url.searchParams.has('pat');
  if (inUrl || !bearer) {
    // Legacy mode: PAT in the URL. Anything invalid looks like a missing route.
    const pat = extractPat(url);
    if (!pat || !patAllowed(pat)) return send(res, 404, 'not found');
    return handleMcp(req, res, pat);
  }
  bearer(req, res, () => {
    const pat = (req.auth?.extra as { pat?: string } | undefined)?.pat;
    if (!pat) return send(res, 401, 'unauthorized');
    void handleMcp(req, res, pat);
  });
});

app.use((_req: express.Request, res: express.Response) => send(res, 404, 'not found'));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('request failed:', (err as Error)?.message ?? 'unknown error');
  if (!res.headersSent) send(res, (err as { status?: number })?.status === 400 ? 400 : 500, 'error');
});

app.listen(PORT, () => {
  console.log(`riseup-remote listening on :${PORT}` + (ALLOWED_HASHES.length
    ? ` (${ALLOWED_HASHES.length} allowed PAT hash(es))`
    : ' (WARNING: ALLOWED_PAT_SHA256 not set; any valid PAT accepted)'));
  console.log(PUBLIC_URL ? `OAuth enabled for ${PUBLIC_URL}/mcp` : 'OAuth disabled (set PUBLIC_URL and TOKEN_ENCRYPTION_KEY to enable)');
});
