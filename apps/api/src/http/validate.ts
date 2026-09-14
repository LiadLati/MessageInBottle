import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { badRequest } from '../lib/errors.js';

// Issues are reduced to path, code and message so a rejected body (a password, a letter) is
// never echoed back in the error response.
export const jsonBody = <T extends ZodType>(schema: T) =>
  zValidator('json', schema, (result) => {
    if (!result.success)
      throw badRequest(
        'validation',
        'invalid request body',
        result.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      );
  });
