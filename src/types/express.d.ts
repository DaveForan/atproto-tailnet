/**
 * Augments Express Request with agent token context.
 *
 * When a request authenticates via `Authorization: Bearer <token>`, the
 * agent middleware populates `req.agentToken` with the resolved token
 * metadata. Route handlers can inspect this to further restrict behaviour
 * (e.g. an agent token can only exercise permissions it was scoped with).
 */
declare namespace Express {
  interface Request {
    agentToken?: {
      id: string;
      tenantId: string;
      userId: string;
      permissions: string[];
    };
  }
}
