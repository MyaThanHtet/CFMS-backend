import type { FastifyReply, FastifyRequest } from 'fastify';

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  request.log.error(error);
  const statusCode = statusCodeOf(error);
  void reply.code(statusCode).send({
    error: {
      code: statusCode >= 500 ? 'internal_error' : 'request_error',
      message: statusCode >= 500 ? 'Unexpected error' : 'Request failed',
    },
  });
}

function statusCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
      return statusCode;
    }
  }
  return 500;
}
