/** Structured JSON logger (pino). LOG_LEVEL sets the level (default "info"). */
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
