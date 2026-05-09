import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { buildApp } from "./app.js";

const app = buildApp(pool);

app.listen({ host: env.API_HOST, port: env.API_PORT }).catch(async (error) => {
  app.log.error(error);
  await pool.end();
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
