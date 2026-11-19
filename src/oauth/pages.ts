/**
 * @module oauth/pages
 * Server-rendered sign-in, consent and error pages for the MCP OAuth flow.
 * No inline scripts or styles (CSP `script-src 'self'; style-src 'self'`) —
 * styling comes from /css/dashboard.css. All interpolated values are escaped.
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${esc(title)} — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <main id="login-page">
${body}
  </main>
</body>
</html>`;
}

/** Sign-in step: posts the handle to the existing Bluesky login with a return path. */
export function signInPage(opts: { clientName: string; returnTo: string }): string {
  return page(
    "Sign in",
    `    <h1>Sign in to connect</h1>
    <p><strong>${esc(opts.clientName)}</strong> wants to manage atproto-tailnet for you.
    Sign in with your Bluesky identity first.</p>
    <form action="/auth/login" method="get">
      <input type="text" name="handle" placeholder="yourname.bsky.social" required
        autocomplete="username" aria-label="Bluesky handle" />
      <input type="hidden" name="redirect" value="${esc(opts.returnTo)}" />
      <button type="submit">Sign in</button>
    </form>`,
  );
}

/** Consent step: Allow / Deny posted with a session-bound CSRF token. */
export function consentPage(opts: {
  clientName: string;
  handle: string;
  redirectHost: string;
  requestId: string;
  csrfToken: string;
}): string {
  return page(
    "Allow access",
    `    <h1>Allow access?</h1>
    <p>Allow <strong>${esc(opts.clientName)}</strong> to manage atproto-tailnet as
    <strong>@${esc(opts.handle)}</strong>?</p>
    <p>It gets the same access you have in the dashboard. It can change settings,
    remove devices and members, and more. You can revoke it at any time in the dashboard.</p>
    <p class="text-dim">After you decide, you go back to ${esc(opts.redirectHost)}.</p>
    <form action="/oauth/consent" method="post">
      <input type="hidden" name="request_id" value="${esc(opts.requestId)}" />
      <input type="hidden" name="csrf_token" value="${esc(opts.csrfToken)}" />
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny" class="btn-ghost">Deny</button>
    </form>`,
  );
}

export function errorPage(title: string, message: string): string {
  return page(title, `    <h1>${esc(title)}</h1>\n    <p>${esc(message)}</p>`);
}
