import path from 'node:path';

export interface AppConfig {
  port: number;
  /** SQLite file path, or ":memory:". */
  dbPath: string;
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.SG_DB ?? path.join(process.cwd(), 'data', 'standby-ghost.db'),
    staticDir: env.SG_STATIC ?? path.join(process.cwd(), 'public'),
  };
}
