import type { FastifyReply } from "fastify";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return reply.code(statusCode).send({ data: null, error: { ...details, code, message } });
}
