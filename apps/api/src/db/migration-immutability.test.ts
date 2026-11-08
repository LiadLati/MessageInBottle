import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Applied migrations are never edited (re-audit ARCH-R-007: 0015 was changed after it was
// written). A database that already ran a migration never runs it again, so an edit would make
// fresh databases and upgraded ones quietly differ. This pins every released migration's
// content; a new migration is added at the end of the list in the same commit that adds it.
// Line endings are normalised, so a Windows checkout hashes the same as Linux.

const DRIZZLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

const RELEASED: Array<[file: string, sha256: string]> = [
  ['0000_init.sql', 'ed39d129d1df654d2b21a2303579ccdeff93ffb8266b87d667d040ca91a36c70'],
  ['0001_geo_anchors.sql', '54e5e851a12c12d96aa63ba990c6bec78ca4fe0cb1067be2da34c9ddf546ab02'],
  ['0002_auth_credentials.sql', '03be671bd8bffa9097b3dc817c36abb4c8f71dc2f04d178b8124a514c6203d07'],
  [
    '0003_email_and_password_resets.sql',
    'ecf62871f8f6b27a0a4e3897da21a95033b68a3bed56f0fdbeeeb874719ad835',
  ],
  ['0004_shore_regions.sql', 'c11f1b9290b44193f06b5e620129505cc8616f3c1007a3c08d63d4d0ec722795'],
  ['0005_bottle_outcomes.sql', 'f461c06ddceb8c1bb4fe588e6941c41cf0d9a65f103a27a998100a84f22503e5'],
  ['0006_public_openings.sql', 'c9e5a9a7a1880bbc924fc94137c28af3e83dcc06530a5bf9cd081a3259e65747'],
  [
    '0007_notification_kinds.sql',
    'e8d2c18a9255971de187a9389b9f116745c1c767df6e59f2f2c8693364c6909c',
  ],
  ['0008_journey_rules.sql', '2f21aa78058a411be27a362e8dc9a97938071b0d4d99627c4ea174fdf4750899'],
  [
    '0009_account_time_zone.sql',
    'eb51191122045fd7da66e21cc5b688d8a3431d01691a45e44b43b1d8dab8a1fc',
  ],
  [
    '0010_reporting_and_moderation.sql',
    '6b368c5e3526e1f90356af2fab0db3ed02f82a7f3b7a82bcbb4fb3b4ae8fcae2',
  ],
  [
    '0011_evidence_retention.sql',
    'e38a6e62f40fedb3a207c54bd873c8b45e75b008a47a3730d836b3cb573a6f0e',
  ],
  [
    '0012_policy_acceptances.sql',
    'adeca69acadd6a69dfa91f6d900468fd4ec2f29ae7d208c746ff725b9ee5ab94',
  ],
  ['0013_account_deletion.sql', '9c4dd376c8717f511508b448ac9d590d6b8c370f30a0520fa5402830ce7dc4c6'],
  [
    '0014_appeal_waiver_and_holds.sql',
    'd3b685792347d25c63972746642f5a1d247d285735cea5851deeee5e4e0f145a',
  ],
  [
    '0015_product_decisions.sql',
    'af1293acf9c7f0ec42a27169cfd5c37c68a080554f1db525be5a42895f89781d',
  ],
  ['0016_account_storms.sql', '25fe7b11cb1e93ea483d0268c6d62da25db6416087cbea70e242fa87e7e2aabc'],
  [
    '0017_account_zone_backfill.sql',
    '4c97f273934238485fe03f93825c02e4f43f0ca67bcf120c36989f807141ce7b',
  ],
];

const digest = (file: string) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(DRIZZLE, file), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

describe('released migrations are append-only (ARCH-R-007)', () => {
  it('has not changed the content of any released migration', () => {
    for (const [file, sha] of RELEASED) expect(digest(file), file).toBe(sha);
  });

  it('lists every migration file, in journal order, with nothing removed or reordered', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = journal.entries.map((e) => `${e.tag}.sql`);
    // Released ones first, in their original order; later ones may follow.
    expect(tags.slice(0, RELEASED.length)).toEqual(RELEASED.map(([f]) => f));
    const files = fs
      .readdirSync(DRIZZLE)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual([...tags].sort());
  });
});
