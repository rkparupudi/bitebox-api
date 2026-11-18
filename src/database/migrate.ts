/**
 * Runs pending migrations once, then exits. In production the deploy pipeline runs this as a
 * one-off task BEFORE rolling out new API containers (with RUN_MIGRATIONS=false on the service),
 * so several containers starting at once never race to migrate the same database.
 *
 *   node dist/database/migrate.js
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

async function main() {
  const ds = await new DataSource({ ...dataSourceOptions(), logging: ['migration', 'error'] }).initialize();
  const ran = await ds.runMigrations({ transaction: 'each' });
  console.log(ran.length ? `Applied: ${ran.map((m) => m.name).join(', ')}` : 'No pending migrations');
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
