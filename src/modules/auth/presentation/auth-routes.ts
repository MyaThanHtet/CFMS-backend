import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../application/authenticator.js';
import { AuthError } from '../domain/auth-error.js';

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

const deviceSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  deviceName: z.string().trim().max(120).optional(),
});

const signUpSchema = deviceSchema.extend({
  name: z.string().trim().min(1).max(80),
  email: emailSchema,
  password: z.string().min(8).max(200),
});

const signInSchema = deviceSchema.extend({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const googleSchema = deviceSchema.extend({
  idToken: z.string().trim().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1),
});

export function registerAuthRoutes(app: FastifyInstance, auth: Authenticator): void {
  app.post('/v1/auth/sign-up', async (request, reply) => {
    const parsed = signUpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError('Check the name, email, and password.'));
    }
    return sendSession(reply, 201, () =>
      auth.signUp({
        ...parsed.data,
        deviceName: parsed.data.deviceName ?? null,
      }),
    );
  });

  app.post('/v1/auth/sign-in', async (request, reply) => {
    const parsed = signInSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError('Check the email and password.'));
    }
    return sendSession(reply, 200, () =>
      auth.signIn({
        ...parsed.data,
        deviceName: parsed.data.deviceName ?? null,
      }),
    );
  });

  app.post('/v1/auth/google', async (request, reply) => {
    const parsed = googleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError('Google sign-in could not be verified.'));
    }
    return sendSession(reply, 200, () =>
      auth.signInWithGoogle({
        ...parsed.data,
        deviceName: parsed.data.deviceName ?? null,
      }),
    );
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError('Sign in again.'));
    }
    return sendSession(reply, 200, () => auth.refresh(parsed.data));
  });

  app.post('/v1/auth/sign-out', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError('Sign in again.'));
    }
    try {
      await auth.signOut(parsed.data);
      return reply.code(204).send();
    } catch (error) {
      return sendAuthFailure(reply, error);
    }
  });
}

function validationError(message: string): { error: { code: string; message: string } } {
  return { error: { code: 'validation_error', message } };
}

async function sendSession(
  reply: FastifyReply,
  statusCode: number,
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return reply.code(statusCode).send(await action());
  } catch (error) {
    return sendAuthFailure(reply, error);
  }
}

function sendAuthFailure(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AuthError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  throw error;
}
