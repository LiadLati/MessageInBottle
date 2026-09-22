// pnpm --filter @mib/api developer:grant -- …   (see tools/grant-role.ts for the full usage)
//
// The developer account is registered by hand like any other and then granted this role; the
// server never creates it.
import { runGrantCli } from './grant-role.js';

runGrantCli('developer');
