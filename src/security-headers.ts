import type { Request, Response, NextFunction } from "express";

/** Security: the app sets HSTS too, because a proxy other than Caddy may not add it. */
export function securityHeaders(publicUrl: string, loopback: boolean) {
  const sendHsts = publicUrl.startsWith("https:") && !loopback;
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (sendHsts) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  };
}
