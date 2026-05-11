# QuotePro Backend Docker Deployment

The backend is designed to run through Docker Compose in local development and on the Hostinger VPS. The Compose stack owns the API container, Postgres container, one-shot migration job, health checks, and persistent database volume.

## Services

- `postgres`: Postgres 16 with the named volume `quotepro_postgres_data`.
- `migrate`: runs `pnpm migrate:prod` after Postgres is healthy.
- `api`: Fastify API on container port `4000`, started only after migrations complete. Publish it with `API_PUBLIC_PORT`.

## Local Run

1. Copy `.env.example` to `.env`.
2. Keep `MOCK_PAYMENTS=true` for local payment redirects.
3. Set `OPENAI_API_KEY` to enable AI quote generation with `OPENAI_QUOTE_MODEL=gpt-5.3-chat-latest`.
4. If another local Postgres already uses `5432`, set `POSTGRES_PORT=55432` or another free host port. The API still talks to Postgres inside Docker on container port `5432`.
5. Start the backend:

```sh
docker compose up --build
```

6. Check the API:

```sh
curl http://localhost:4000/health
```

7. Point the web app at the API with `NEXT_PUBLIC_API_URL=http://localhost:4000`.
8. Point Flutter at the API with `--dart-define=QUOTEPRO_API_URL=http://localhost:4000`.

## Hostinger VPS Run

1. Install Docker and the Docker Compose plugin on the VPS.
2. Clone or upload the repo.
3. Create a production `.env` from `.env.example`.
4. Set at minimum:

```sh
POSTGRES_PASSWORD=<strong-password>
APP_PUBLIC_URL=https://your-client-web-domain
CORS_ORIGINS=https://your-client-web-domain
MOCK_PAYMENTS=false
PAYSTACK_SECRET_KEY=<paystack-secret>
PAYSTACK_WEBHOOK_SECRET=<optional-webhook-signing-secret>
OPENAI_API_KEY=<openai-api-key>
OPENAI_QUOTE_MODEL=gpt-5.3-chat-latest
OPENAI_QUOTE_FALLBACK_MODEL=gpt-5.3-chat-latest
OPENAI_REQUEST_TIMEOUT_MS=25000
```

AI quote generation is bounded by `OPENAI_REQUEST_TIMEOUT_MS`. When an OpenAI key is configured, the API does not return deterministic fallback quotes; generation either returns an AI quote or asks the user to retry.

If `PAYSTACK_WEBHOOK_SECRET` is empty, the API verifies webhook signatures with `PAYSTACK_SECRET_KEY`.

5. Start the production stack:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

6. Put Nginx, Caddy, or the Hostinger reverse proxy in front of `api:4000`.

## Verify deployment

From any machine that can reach the API:

```sh
QUOTEPRO_API_URL=https://your-api-domain pnpm verify
```

This checks `GET /health` returns `{ ok: true }`.

7. Configure Paystack webhook URL as:

```text
https://your-api-domain/payments/paystack/webhook
```

## Migrations

Migrations run automatically through the `migrate` service before `api` starts.

To run them manually:

```sh
docker compose run --rm migrate
```

## Logs And Health

```sh
docker compose ps
docker compose logs -f api
docker compose logs -f postgres
curl http://localhost:4000/health
```

The API health check also verifies database connectivity.

## Backup

Create a database backup:

```sh
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > quotepro-backup.sql
```

Restore a backup:

```sh
docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" < quotepro-backup.sql
```

Keep backups outside the repo and copy them off the VPS regularly.

## Updating Production

```sh
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The `migrate` job is idempotent and records applied files in `schema_migrations`.
