import type { FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { sendError } from "./http-error";

// Errors that mean "the database is unreachable or too slow right now", not
// "this request is wrong": the serverless Postgres waking up, a dropped
// connection, the pool or a transaction timing out. Worth a retry in a moment.
const UNAVAILABLE_CODES = new Set([
  "P1001", // can't reach the database server
  "P1002", // the server was reached but timed out
  "P1008", // operation timed out
  "P1017", // the server closed the connection
  "P2024", // timed out waiting for a pooled connection
  "P2028", // transaction expired (it ran past its timeout)
]);

export function isDbUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return UNAVAILABLE_CODES.has(err.code);
  return false;
}

const RETRY_AFTER_SECONDS = 3;

/**
 * 503 SERVICE_UNAVAILABLE. `retryable` tells the client whether repeating the
 * request is safe: true when nothing was done yet (a read, or a failure in a
 * check before the route ran), false when a write may have gone halfway.
 */
export function sendDbUnavailable(reply: FastifyReply, { retryable }: { retryable: boolean }) {
  reply.header("Retry-After", String(RETRY_AFTER_SECONDS));
  return sendError(reply, 503, "SERVICE_UNAVAILABLE", "We couldn't reach our servers just now. Please try again in a moment.", {
    retryable,
  });
}
