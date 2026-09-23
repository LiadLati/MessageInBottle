import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './app.js';

// Response headers the API sets itself, so a deployment is protected even behind a reverse
// proxy that adds none (audit SEC-014). Two shapes:
//
//   • the server-rendered pages (/legal/*, /support): one inline <style>, no script, no image,
//     and one form (the public deletion page) that may only post back to this origin and must
//     never be framed — a credential form inside someone else's frame is a phishing kit;
//   • everything else is JSON, which needs no resources at all.
//
// Strict-Transport-Security is sent only when the configured public URL is https, because a
// browser that receives it over plain http on localhost would refuse the dev server for a year.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const h = c.res.headers;
  const page = c.req.path === '/support' || c.req.path.startsWith('/legal');
  h.set('Content-Security-Policy', page ? PAGE_CSP : API_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (c.get('ctx').config.appUrl.startsWith('https://'))
    h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});
