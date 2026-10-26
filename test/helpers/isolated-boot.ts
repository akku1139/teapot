import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface IsolatedBoot {
  env: Record<string, string>;
  configPath: string;
  dataDir: string;
}

export function isolatedBootEnv(
  dataDir: string,
  port: number,
  seed?: Record<string, unknown>,
): IsolatedBoot {
  const configPath = path.join(dataDir, "config.json");
  const body = seed && Object.keys(seed).length ? { ...seed, dataDir, port } : { dataDir, port, agents: [] };
  writeFileSync(configPath, JSON.stringify(body, null, 2) + "\n");
  return {
    configPath,
    dataDir,
    env: {
      TEAPOT_CONFIG: configPath, 
      TEAPOT_DATA_DIR: dataDir,
      TEAPOT_PORT: String(port),
    },
  };
}

export function configExists(p: string): boolean {
  return existsSync(p);
}
