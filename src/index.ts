import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

export const name = 'dsh-dotenv';
export const inject: string[] = [];
export const Config = Schema.object({
  path: Schema.string().description('Explicit dotenv path; absent means no loading'),
  root: Schema.string().description('Host-local containment root; defaults to process.cwd()'),
});
export type Config = ReturnType<typeof Config>;
const MAX_BYTES = 256 * 1024;

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.path === undefined) return;
  const lifetime = new AbortController();
  const pending = load(ctx, config, config.path, lifetime.signal);
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Dotenv plugin disposed'));
    await pending.catch(() => {});
  }, 'dotenv startup lifetime');
  return pending;
}

async function load(ctx: Context, config: Config, path: string, signal: AbortSignal): Promise<void> {
  const check = () => {
    signal.throwIfAborted();
    ctx.fiber.assertActive();
  };
  try {
    check();
    if (!path.trim() || typeof constants.O_NOFOLLOW !== 'number') throw new Error();
    const root = await realpath(resolve(config.root ?? process.cwd()));
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
    let current = root;
    const parts = rel.split(sep);
    for (const [index, part] of parts.entries()) {
      check();
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error();
    }
    check();
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        check();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error();
      text = buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
    check();
    const values = parseEnv(text.replace(/^\uFEFF/, ''));
    // This synchronous publication is indivisible between plugin loads in this process.
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
    }
  } catch {
    throw new Error('dsh-dotenv: could not load configured file (must be a regular file inside root, without symlinks, at most 256 KiB)');
  }
}
