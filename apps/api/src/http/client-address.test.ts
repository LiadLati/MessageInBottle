import { describe, expect, it } from 'vitest';
import { rateLimitKeyOf } from './client-address.js';

// Audit SEC-R-007: rate limits key an IPv6 client by its /64, the block one subscriber is
// normally given, so a single client cannot take a fresh bucket per request.
describe('the rate-limit key of a client address', () => {
  it('keeps an IPv4 address as it is, including one written in IPv6 form', () => {
    expect(rateLimitKeyOf('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKeyOf('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKeyOf('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('reduces every address in one IPv6 /64 to the same key', () => {
    const key = rateLimitKeyOf('2001:db8:1:2::1');
    expect(key).toBe('2001:db8:1:2::/64');
    for (const same of [
      '2001:0db8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '[2001:db8:1:2::abcd]',
      '2001:db8:1:2::1%eth0',
      '2001:db8:1:2:0:0:192.0.2.1',
    ])
      expect(rateLimitKeyOf(same), same).toBe(key);
    expect(rateLimitKeyOf('2001:db8:1:3::1')).not.toBe(key);
    expect(rateLimitKeyOf('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves anything unparseable as it is rather than merging it with others', () => {
    for (const odd of ['local', 'not:an:address::x', '1::2::3'])
      expect(rateLimitKeyOf(odd)).toBe(odd);
  });
});
