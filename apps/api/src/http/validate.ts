import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { badRequest } from '../lib/errors.js';

export const jsonBody = <T extends ZodType>(schema: T) =>
  zValidator('json', schema, (result) => {
    if (!result.success)
      throw badRequest('validation', 'invalid request body', result.error.issues);
  });
