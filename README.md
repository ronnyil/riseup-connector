# riseup-connector

A small, **stateless** remote MCP server (Streamable HTTP) that wraps the official
[RiseUp MCP server](https://github.com/riseup-oss/mcp) (`@riseup-oss/mcp`) so you can
add it as a **custom connector on claude.ai** and use it from the Claude web, desktop
and mobile apps.

The upstream package is stdio-only and reads the token from `RISEUP_PAT`. This server
**stores no token**. It accepts your RiseUp Personal Access Token (PAT) in one of two ways:

| Mode | Connector URL | Where the PAT travels |
|---|---|---|
| **OAuth** (recommended) | `https://<host>/mcp` | You paste it once into a sign-in page; Claude then sends an encrypted copy in the `Authorization` header. Never in a URL. |
| URL | `https://<host>/mcp/<riseup_pat_...>` | In the URL path of every request. The URL is the credential. |

## How it works

- Tool names, descriptions and input schemas come from the upstream package
  (`registerBudgetTool`, `registerTransactionsTool`) through a small shim; the handlers
  are swapped for per-request ones that call upstream's `fetchBudget` /
  `fetchTransactions` with the caller's PAT.
- Exposed tools: `get_budget`, `get_transactions` (read-only).
- RiseUp API base is hard-coded to `https://input.riseup.co.il` (no override).
- Stateless: a fresh `McpServer` + transport per request, `POST` only, 1 MB body limit.
- Request URLs, headers and tokens are never logged. `GET /healthz` returns `200 ok`.

### OAuth mode, in detail

The server is its own minimal OAuth 2.1 authorization server (built on the MCP SDK's
OAuth handlers: discovery metadata, dynamic client registration, PKCE S256):

1. Claude calls `/mcp` without a token, gets `401` pointing at the OAuth metadata, and
   registers itself as a client. Only Claude's callback URLs
   (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`)
   are accepted.
2. Your browser opens `/authorize`, a page where you paste your PAT. It is sent in the
   form body (HTTPS POST), checked against the format and the hash allowlist.
3. The PAT is sealed with **AES-256-GCM** using `TOKEN_ENCRYPTION_KEY` into the
   authorization code, the access token (1 hour) and the refresh token (30 days, never
   extended). Claude only ever holds these opaque blobs.
4. On each request the server decrypts the bearer token in memory and calls RiseUp.

Nothing is written to disk or a database. The only server-side secret is
`TOKEN_ENCRYPTION_KEY`. Codes are single-use (tracked in memory until they expire).
Tokens are bound to the client they were issued to.

To **sign out a token**, remove its hash from `ALLOWED_PAT_SHA256`: every access and
refresh token carrying it stops working immediately. To **sign out everything**, change
`TOKEN_ENCRYPTION_KEY`.

## Option A: no computer (Render, free)

Everything below can be done from a phone browser. [Render](https://render.com/docs/free)
builds the Dockerfile straight from this GitHub repo and gives you an `https://` URL.

1. Sign up at <https://render.com> with **Sign in with GitHub**, and allow Render access
   to this repository.
2. **New → Blueprint**, pick this repo, and **Apply**. When asked for
   `CONNECT_PASSWORD`, choose a password (you'll type it once when connecting Claude).
   `TOKEN_ENCRYPTION_KEY` is generated for you; `PUBLIC_URL` is detected automatically.
3. Wait for the deploy to go **Live**, then copy the service URL
   (e.g. `https://riseup-connector-xxxx.onrender.com`). Opening `<URL>/healthz` shows `ok`.
4. Create a RiseUp PAT (scope `budget:read`) at
   <https://input.riseup.co.il/developer/tokens>.
5. claude.ai → **Settings → Connectors → Add custom connector**: URL `<URL>/mcp`,
   OAuth fields empty → **Connect** → enter your password and PAT → **Connect**.

Free-tier notes: the service sleeps after 15 minutes without traffic and takes about a
minute to wake, so the first RiseUp question after a break may be slow or need a retry.
Render's free hours (750/month) cover one service running all month. On Render use OAuth
mode only (setting `CONNECT_PASSWORD` turns URL mode off), since platform request logs
record URL paths.

Every 30 days: create a new PAT, then in Claude **Disconnect → Connect** and paste it.

## Option B: your own always-on machine (Docker + Cloudflare Tunnel)

You need an always-on machine with Docker (home server, Raspberry Pi, VPS) and a free
Cloudflare account with a domain.

### 1. Get the code

```sh
git clone https://github.com/ronnyil/riseup-connector.git
cd riseup-connector
cp .env.example .env
```

### 2. Create a RiseUp PAT

Go to <https://input.riseup.co.il/developer/tokens> and create a token with the
**`budget:read`** scope. Copy it. It is shown only once and looks like `riseup_pat_...`.

### 3. Hash it for the allowlist

```sh
 printf '%s' 'riseup_pat_...' | sha256sum
```

(The leading space keeps it out of shell history in most shells. Use `printf '%s'`, not
`echo`, so no newline is hashed.) Put the 64-hex-char digest in `.env`:

```
ALLOWED_PAT_SHA256=<digest>
```

If it is empty, any well-formed PAT is accepted and a warning is logged at startup.
Alternatively (or additionally) set `CONNECT_PASSWORD`; the sign-in page then asks for it,
and URL mode is turned off.

### 4. Create a Cloudflare Tunnel

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type
*Cloudflared*). Copy the token from the install command into `.env` as `TUNNEL_TOKEN`.

Add a **public hostname**: a hard-to-guess subdomain (e.g. `rs-7k2q.example.com`),
service type **HTTP**, URL **`riseup:8787`**. The `riseup` container publishes no ports,
so it is reachable only through the tunnel.

**Don't put Cloudflare Access in front of this hostname.** claude.ai connects from
Anthropic's servers and can't get through an Access login.

### 5. Enable OAuth

In `.env`:

```
PUBLIC_URL=https://rs-7k2q.example.com
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -hex 32>
```

Set both or neither. (Any random secret of 32+ characters works as the key.) With both empty only URL mode is available.

### 6. Start it

```sh
docker compose up -d --build
docker compose logs riseup
# riseup-remote listening on :8787 (1 allowed PAT hash(es))
# OAuth enabled for https://rs-7k2q.example.com/mcp
curl https://rs-7k2q.example.com/healthz   # ok
```

### 7. Add the connector on claude.ai

**Settings → Connectors → Add custom connector**

- Name: `RiseUp`
- URL: `https://rs-7k2q.example.com/mcp`
- Leave the OAuth Client ID / Secret fields empty (Claude registers itself).

Click **Connect**. A page from your server opens. Paste your PAT, then press **Connect**.
You land back in Claude, connected. Delete the PAT from wherever you kept it
temporarily.

Connectors added on claude.ai also work in the Android/iOS apps.

*(URL mode instead: use `https://<host>/mcp/riseup_pat_...` as the connector URL and
skip step 5. Anyone with that URL can use your token, so treat it like a password.)*

## Token rotation (every 30 days)

RiseUp PATs expire after 30 days. When yours is about to expire, or the chat says
"PAT was rejected (401)":

1. Create a new PAT at <https://input.riseup.co.il/developer/tokens> and hash it.
2. Set `ALLOWED_PAT_SHA256=<new digest>` in `.env` and run `docker compose up -d`.
3. On claude.ai → Settings → Connectors → RiseUp: **Disconnect**, then **Connect** and
   paste the new PAT. (URL mode: edit the connector URL instead.)
4. Revoke the old PAT on the RiseUp tokens page.

## Troubleshooting

- **Sign-in page says "That token was not accepted":** its hash isn't in
  `ALLOWED_PAT_SHA256`, or it was pasted incompletely. Re-run step 3 and compare.
- **"This sign-in link has expired":** the page was open more than 10 minutes. Click
  Connect in Claude again.
- **Connector fails right after "Connect":** check `PUBLIC_URL` is exactly the public
  `https://` hostname (no path, no trailing slash needed) and that `/healthz` loads.
- **`/healthz` doesn't load:** `docker compose ps`, `docker compose logs cloudflared`, and
  check the tunnel's service is `http://riseup:8787`.
- **Update:** `git pull && docker compose up -d --build`.

## Local development

```sh
npm install
npm run build
PUBLIC_URL=http://localhost:8787 TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) npm start
```

Smoke test URL mode with a **fake** token (never put a real one in shell history):

```sh
FAKE=riseup_pat_$(printf 'a%.0s' $(seq 43))
curl -s -X POST "http://localhost:8787/mcp/$FAKE" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The server trusts one reverse-proxy hop (`trust proxy = 1`) for the OAuth endpoints'
rate limiting, which matches cloudflared or a single platform router.

## When upstream adds a tool

The shim forwards only tools that have a remote handler. Anything new is skipped with a
warning like `Skipping upstream tool "get_foo": no remote handler yet.` (logged on each
request). To add it:

1. Bump `@riseup-oss/mcp` in `package.json` (exact version) and run `npm install`.
2. Import the new `registerXTool` and its `fetchX` from
   `@riseup-oss/mcp/dist/tools/<file>.js` in `src/server.ts`.
3. Add an entry to `handlers` keyed by the tool name, calling `fetchX(args..., cfg)` and
   returning `json(result)` (copy any argument checks the upstream handler does).
4. Call `registerXTool(shim)` in `buildServer`.
5. `npm run build`, test with `tools/list`, then `docker compose up -d --build`.

Handlers must take the config from the `cfg` argument, never from
`loadConfigFromEnv()`, which reads `RISEUP_PAT`/`RISEUP_API_BASE` from the environment.
