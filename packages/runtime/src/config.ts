import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ModelProvider } from '@openlab/protocol';

export interface RuntimePaths {
  home: string;
  database: string;
  plugins: string;
  skills: string;
  snapshots: string;
  logs: string;
  providers: string;
  deepSeekPricing: string;
  documentRecovery: string;
  jobs: string;
  toolchains: string;
}

export interface RuntimeConfig {
  host: '127.0.0.1';
  port: number;
  authToken: string;
  projectRoot: string;
  /** Additional user-approved folders that are first-class roots of this project. */
  projectRoots?: string[];
  home: string;
  demo: boolean;
  deepSeekApiKey?: string;
  credentials?: Record<string, string>;
  /** Authenticated loopback broker owned by Electron Main. It exposes browser actions but never profile credentials. */
  browserBroker?: { url: string; token: string };
  /** In-process deterministic provider fixture; never sent across the Electron child-process boundary. */
  modelProvider?: ModelProvider;
}

export function defaultOpenLabHome(): string {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || join(process.cwd(), '.openlab', 'runtime');
  return resolve(base, 'OpenLab');
}

export function runtimePaths(home: string): RuntimePaths {
  const paths: RuntimePaths = {
    home: resolve(home),
    database: join(home, 'openlab.db'),
    plugins: join(home, 'plugins'),
    skills: join(home, 'skills'),
    snapshots: join(home, 'snapshots'),
    logs: join(home, 'logs'),
    providers: join(home, 'providers.json'),
    deepSeekPricing: join(home, 'pricing', 'deepseek.json'),
    documentRecovery: join(home, 'recovery', 'documents'),
    jobs: join(home, 'jobs'),
    toolchains: join(home, 'toolchains'),
  };
  for (const path of [paths.home, paths.plugins, paths.skills, paths.snapshots, paths.logs, paths.documentRecovery, paths.jobs, paths.toolchains, dirname(paths.deepSeekPricing)]) mkdirSync(path, { recursive: true });
  mkdirSync(dirname(paths.database), { recursive: true });
  return paths;
}
