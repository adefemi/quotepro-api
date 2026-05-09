# QuotePro API

Standalone backend API for QuotePro. This repo contains only the Fastify API, PostgreSQL migrations, Docker deployment files, and API tests.

## Stack

- Fastify and TypeScript
- PostgreSQL
- Zod validation
- Paystack payment initialization and webhooks
- OpenAI-assisted quote drafting with deterministic fallback
- Docker Compose for local and VPS deployment

## Local Setup

Install dependencies:

```sh
corepack pnpm install
```

Create a local environment file:

```sh
cp .env.example .env
```

Start Postgres, migrations, and the API:

```sh
docker compose up --build
```

Verify the API:

```sh
corepack pnpm verify
```

## Development

Run locally against the configured database:

```sh
corepack pnpm dev
```

Run migrations:

```sh
corepack pnpm migrate
```

Run tests:

```sh
corepack pnpm test
```

Build:

```sh
corepack pnpm build
```

## Production VPS Deploy

On the VPS:

```sh
git clone git@github.com:YOUR_ACCOUNT/quotepro-api.git
cd quotepro-api
cp .env.example .env
nano .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Set at minimum:

```sh
POSTGRES_PASSWORD=<strong-password>
APP_PUBLIC_URL=https://your-client-web-domain
CORS_ORIGINS=https://your-client-web-domain
MOCK_PAYMENTS=false
PAYSTACK_SECRET_KEY=<paystack-secret>
OPENAI_API_KEY=<openai-api-key>
OPENAI_QUOTE_MODEL=gpt-5-nano
OPENAI_QUOTE_FALLBACK_MODEL=gpt-4.1-mini
OPENAI_REQUEST_TIMEOUT_MS=8000
```

After adding HTTPS and a domain, configure Paystack webhook:

```text
https://your-api-domain/payments/paystack/webhook
```

The mobile app should be built with:

```sh
--dart-define=QUOTEPRO_API_URL=https://your-api-domain
```
