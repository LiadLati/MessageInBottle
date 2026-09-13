import { describe, expect, it } from 'vitest';
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  confirmationProblem,
  emailProblem,
  normalizeEmail,
  normalizeUsername,
  passwordProblem,
  usernameProblem,
} from './auth.js';

describe('credential rules', () => {
  it('normalizes usernames case-insensitively', () => {
    expect(normalizeUsername('  Ada ')).toBe('ada');
    expect(normalizeUsername('DEE_2')).toBe('dee_2');
  });

  it('explains username problems', () => {
    expect(usernameProblem('')).toMatch(/choose/i);
    expect(usernameProblem('a')).toMatch(/at least 2/);
    expect(usernameProblem('a'.repeat(33))).toMatch(/at most 32/);
    expect(usernameProblem('ada!')).toMatch(/letters, digits/);
    expect(usernameProblem('Ada_1')).toBeNull();
  });

  it('explains password problems without weakening the schema', () => {
    expect(passwordProblem('')).toMatch(/choose/i);
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('Ada_1234', 'ada_1234')).toMatch(/same as the username/);
    expect(passwordProblem('correct horse battery')).toBeNull();
    expect(RegisterRequestSchema.safeParse({ username: 'ada', password: 'short' }).success).toBe(
      false,
    );
    expect(
      RegisterRequestSchema.safeParse({
        username: 'new_user',
        email: 'new@example.com',
        password: 'long enough',
      }).success,
    ).toBe(true);
  });

  it('validates e-mail addresses and normalizes them', () => {
    expect(emailProblem('')).toMatch(/enter/i);
    expect(emailProblem('not-an-email')).toMatch(/does not look/);
    expect(emailProblem('mira@example.com')).toBeNull();
    expect(normalizeEmail('  Mira@Example.COM ')).toBe('mira@example.com');
    expect(
      RegisterRequestSchema.safeParse({ username: 'mira', password: 'long enough', email: 'x' })
        .success,
    ).toBe(false);
    expect(
      ResetPasswordRequestSchema.safeParse({ token: 'short', password: 'long enough' }).success,
    ).toBe(false);
  });

  it('requires both fields to sign in', () => {
    expect(LoginRequestSchema.safeParse({ username: 'ada' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 'ada', password: '' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 'ada', password: 'x' }).success).toBe(true);
  });

  it('checks the confirmation field', () => {
    expect(confirmationProblem('abcdefgh', '')).toMatch(/repeat/i);
    expect(confirmationProblem('abcdefgh', 'abcdefgX')).toMatch(/do not match/);
    expect(confirmationProblem('abcdefgh', 'abcdefgh')).toBeNull();
  });
});
