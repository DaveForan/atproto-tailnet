/** Adds `req.agentToken`, set when a request authenticates with a Bearer agent token. */
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
