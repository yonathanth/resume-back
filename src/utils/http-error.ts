import type { FastifyReply } from "fastify";

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ data: null, error: { code, message } });
}
