import fs from 'node:fs';
import path from 'node:path';
import { API_ROOT } from '../config.js';

// `.env.example` tells people to put configuration (SMTP credentials among it) in a .env file,
// so the API has to actually read one. Values already present in the real environment always
// win, so a variable set on the command line or by the host is never overridden by a file.
// Format: KEY=value per line, # comments, blank lines ignored, optional matching quotes.
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// apps/api/.env first, then the repository root .env; neither overrides the real environment.
export const ENV_FILES = [path.join(API_ROOT, '.env'), path.resolve(API_ROOT, '..', '..', '.env')];

export function loadEnvFiles(files: string[] = ENV_FILES, env = process.env): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    let contents: string;
    try {
      if (!fs.existsSync(file)) continue;
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseEnvFile(contents))) {
      if (env[key] === undefined) env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}
