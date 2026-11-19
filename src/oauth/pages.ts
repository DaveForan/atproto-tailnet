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

/**
 * Consent step: Allow / Deny posted with a session-bound CSRF token.
 *
 * Anti-phishing: the app name is self-asserted at dynamic registration, so it
 * is labelled "Unverified app" and the redirect host — the one thing the
 * client cannot fake — is shown prominently in the heading and body. The
 * operator scope is a separate, unchecked opt-in shown only to operators.
 */
export function consentPage(opts: {
  clientName: string;
  handle: string;
  redirectHost: string;
  requestId: string;
  csrfToken: string;
  /** False for dynamically registered clients (all of them today). */
  verified?: boolean;
  /** Show the "Also allow instance operator actions" checkbox (operators only). */
  offerOperatorScope?: boolean;
}): string {
  const host = esc(opts.redirectHost);
  const badge = opts.verified
    ? ""
    : `\n    <p><strong>Unverified app.</strong> The name &ldquo;${esc(opts.clientName)}&rdquo; was chosen by the app itself and has not been verified. Only continue if you started this connection and trust <strong>${host}</strong>.</p>`;
  const operatorBox = opts.offerOperatorScope
    ? `\n      <p><label><input type="checkbox" name="operator" value="1" />
        Also allow instance operator actions (delete tailnets, disable users, suspend tailnets, change instance settings)</label></p>`
    : "";
  return page(
    "Allow access",
    `    <h1>Allow ${host} to access your account?</h1>${badge}
    <p>Allow <strong>${esc(opts.clientName)}</strong> at <strong>${host}</strong> to manage atproto-tailnet as
    <strong>@${esc(opts.handle)}</strong>?</p>
    <p>It gets the same access you have in the dashboard. It can change settings,
    remove devices and members, and more. You can revoke it at any time in the dashboard.</p>
    <p>After you decide, you go back to <strong>${host}</strong>.</p>
    <form action="/oauth/consent" method="post">
      <input type="hidden" name="request_id" value="${esc(opts.requestId)}" />
      <input type="hidden" name="csrf_token" value="${esc(opts.csrfToken)}" />${operatorBox}
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny" class="btn-ghost">Deny</button>
    </form>`,
  );
}

export function errorPage(title: string, message: string): string {
  return page(title, `    <h1>${esc(title)}</h1>\n    <p>${esc(message)}</p>`);
}
