import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./pool.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, "../../migrations");

async function migrate() {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await pool.query("select 1 from schema_migrations where id = $1", [file]);

    if (applied.rowCount) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");

    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into schema_migrations (id) values ($1)", [file]);
      await pool.query("commit");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
}

migrate()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
