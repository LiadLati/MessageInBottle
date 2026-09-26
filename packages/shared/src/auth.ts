import { z } from 'zod';
import { UsernameSchema } from './api.js';
import { PolicyAcceptanceRequestSchema } from './policies.js';

// Credential rules shared by the API (authoritative) and the client (early, friendly messages).
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// Usernames are stored and compared in one canonical form so "Ada" and "ada" are the same
// account; the display name keeps the casing the person typed.
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

// E-mail addresses are stored in one canonical form (trimmed, lower-case) so lookups and the
// uniqueness rule are case-insensitive.
export const EMAIL_MAX_LENGTH = 254;
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
export const EmailSchema = z.string().trim().max(EMAIL_MAX_LENGTH).email();

// Creating an account requires accepting the Terms of Use and the Community Rules and
// acknowledging the Privacy Policy, each as a literal true, with the versions that were shown.
// There is no default and no way to register without them.
export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  policies: PolicyAcceptanceRequestSchema,
});

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().max(EMAIL_MAX_LENGTH),
});
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
// Product decision 3: registering with an address that already has an account says so plainly.
// An accepted privacy trade-off (docs/REMEDIATION.md); forgot-password still never reveals
// whether an address is registered.
export const EMAIL_TAKEN_MESSAGE =
  'This email is already registered. Sign in or reset your password.';

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(32).max(128),
  password: PasswordSchema,
});

export function emailProblem(email: string): string | null {
  const v = email.trim();
  if (v.length === 0) return 'Enter your email address.';
  if (v.length > EMAIL_MAX_LENGTH || !EmailSchema.safeParse(v).success)
    return 'That does not look like an email address.';
  return null;
}
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export function usernameProblem(username: string): string | null {
  const v = username.trim();
  if (v.length === 0) return 'Choose a username.';
  if (v.length < 2) return 'Usernames need at least 2 characters.';
  if (v.length > 32) return 'Usernames can have at most 32 characters.';
  if (!/^[a-z0-9_]+$/i.test(v)) return 'Use letters, digits and underscores only.';
  return null;
}

export function passwordProblem(password: string, username = ''): string | null {
  if (password.length === 0) return 'Choose a password.';
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Passwords can have at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (username && password.toLowerCase() === normalizeUsername(username))
    return 'The password cannot be the same as the username.';
  return null;
}

export function confirmationProblem(password: string, confirmation: string): string | null {
  if (confirmation.length === 0) return 'Repeat the password.';
  if (confirmation !== password) return 'The two passwords do not match.';
  return null;
}
