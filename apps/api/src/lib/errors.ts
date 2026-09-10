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
