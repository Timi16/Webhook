import { execFileSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection string to the maintenance database, used to create per-file databases. */
    adminUrl: string;
    /** Migrated database that per-file databases are cloned from. Never connect to it in tests. */
    templateDb: string;
  }
}

/** One throwaway Postgres 16 for the whole run, migrated with the real migrations. */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withCommand(["postgres", "-c", "max_connections=300", "-c", "fsync=off"])
    .start();
  const templateUrl = container.getConnectionUri();

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: project.config.root,
    env: { ...process.env, DATABASE_URL: templateUrl },
    stdio: "pipe",
  });

  const admin = new URL(templateUrl);
  admin.pathname = "/postgres";
  project.provide("adminUrl", admin.toString());
  project.provide("templateDb", container.getDatabase());

  return async () => {
    await container.stop();
  };
}
