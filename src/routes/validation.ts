/**
 * @module routes/validation
 * Request body validation with the one 400 body every route returns.
 */

import type { Request, Response } from "express";
import type { z } from "zod";

/**
 * Parses `req.body` with `schema`. On failure it sends
 * 400 `{ error: "Invalid body", details }` and returns null.
 * `emptyAsObject` parses a missing body as `{}`.
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  req: Request,
  res: Response,
  opts: { emptyAsObject?: boolean } = {},
): z.SafeParseSuccess<z.output<S>> | null {
  const parsed = schema.safeParse(opts.emptyAsObject ? (req.body ?? {}) : req.body);
  if (parsed.success) return parsed;
  res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
  return null;
}
