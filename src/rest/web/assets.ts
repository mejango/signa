import { createHash } from 'node:crypto';
import type { Hono } from 'hono';

/** Logical asset file ('wallet.js') to the content-hashed name pages reference ('wallet.0123456789ab.js'). */
export type AssetNames = Readonly<Record<string, string>>;

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const types: Record<string, string> = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const split = (file: string) => { const dot = file.lastIndexOf('.'); return [file.slice(0, dot), file.slice(dot + 1)] as const; };

export function hashedAssetName(file: string, body: string): string {
  const [stem, ext] = split(file);
  return `${stem}.${createHash('sha256').update(body).digest('hex').slice(0, 12)}.${ext}`;
}

export const assetHref = (base: string, file: string, names?: AssetNames) => `${base}/assets/${names?.[file] ?? file}`;

/** Serves each JS/CSS body under its hashed name, cached for a year: a new body is a new name. Any other
 * name for the same file (the plain name, or a hash from another deploy that a page loaded before a deploy
 * still asks for) gets the current body uncached, so a deploy never breaks a page mid-flight. */
export function mountAssets(app: Hono<any>, base: string, files: Record<string, string>): AssetNames {
  const names: Record<string, string> = {};
  for (const [file, body] of Object.entries(files)) {
    const [stem, ext] = split(file), hashed = hashedAssetName(file, body);
    names[file] = hashed;
    const pattern = `${stem.replace(/[.\-]/g, '\\$&')}(?:\\.[0-9a-f]{12})?\\.${ext}`;
    app.get(`${base}/assets/:file{${pattern}}`, c => c.body(body, 200, {
      'Content-Type': types[ext]!, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': c.req.param('file') === hashed ? IMMUTABLE_CACHE : 'no-store' }));
  }
  return names;
}
