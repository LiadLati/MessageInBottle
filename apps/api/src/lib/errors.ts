export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new AppError(404, 'not_found', `${what} not found`);
export const unauthorized = () => new AppError(401, 'unauthorized', 'authentication required');
export const forbidden = (message = 'not allowed') => new AppError(403, 'forbidden', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
// A spent budget. `retryAfterSeconds` is how long the caller must wait for the window to free
// up, so a client can say when reporting will work again instead of guessing.
export const tooManyRequests = (
  retryAfterMs: number,
  message = 'too many attempts, try again later',
) =>
  new AppError(429, 'rate_limited', message, {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
