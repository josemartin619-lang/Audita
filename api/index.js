/**
 * Vercel serverless entrypoint.
 *
 * Deliberately plain JavaScript importing the COMPILED output in ../dist. The
 * source uses `moduleResolution: "Bundler"` (i.e. `./foo.js` specifiers that
 * point at `./foo.ts`), which Vercel's TypeScript function builder does not
 * resolve. `npm run build` emits real `.js` files whose specifiers resolve
 * natively, so this file has no build-tool opinions at all.
 *
 * Two things make this correct rather than merely working:
 *
 *  1. Boot happens ONCE per cold start and every request awaits the same
 *     promise. Booting per request would re-seed and re-read on every call.
 *  2. The handler does not resolve until the response has finished AND every
 *     durable write has landed. Vercel may freeze the microVM the moment the
 *     handler resolves; resolving early is how you lose a posted entry.
 */

let bootPromise = null;

async function getApp() {
  const { boot, logBoot, ConfigError } = await import('../dist/api/boot.js');
  try {
    const result = await boot();
    logBoot(result);
    return result.app;
  } catch (e) {
    // Surface a readable cause instead of Vercel's generic FUNCTION_INVOCATION_FAILED.
    const config = e instanceof ConfigError;
    const err = new Error(e && e.message ? e.message : String(e));
    err.statusCode = config ? 503 : 500;
    err.isConfig = config;
    throw err;
  }
}

export default async function handler(req, res) {
  let app;
  try {
    // Retry boot on the next request if it failed (an unreachable database at
    // cold start should not poison this instance for its whole lifetime).
    if (!bootPromise) bootPromise = getApp();
    app = await bootPromise;
  } catch (e) {
    bootPromise = null;
    res.statusCode = e.statusCode || 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: false,
      error: e.isConfig ? 'Configuration error' : 'Startup failed',
      detail: e.message,
      hint: 'Set AUDITA_JWT_SECRET (required) and DATABASE_URL (for durable '
        + 'storage) in the Vercel project\'s Environment Variables, then redeploy.',
    }));
    return;
  }

  await new Promise((resolve) => {
    res.on('close', resolve);
    res.on('finish', resolve);
    app(req, res);
  });

  // Belt and braces: the app already holds mutating responses until their
  // durable write lands, but a background write issued outside a request path
  // would otherwise be lost when this microVM freezes.
  try {
    const { flushWrites } = await import('../dist/persistence/store.js');
    await flushWrites();
  } catch (e) {
    console.error('[vercel] durable write did not land before freeze:', e);
  }
}
