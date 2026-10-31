/**
 * @module logger
 * Structured JSON logger (pino). Defaults to "info" level; override
 * with the LOG_LEVEL environment variable.
 */
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
