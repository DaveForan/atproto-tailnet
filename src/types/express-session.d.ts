import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    did?: string;
    postLoginRedirect?: string;
  }
}
