import {
  PUBLISHED_DOCUMENTS,
  SUPPORT_CATEGORIES,
  SUPPORT_NAME,
  SUPPORT_NEVER_SEND,
  supportMailto,
  type PolicyBlock,
  type PolicyDocument,
} from '@mib/shared';

// The public legal pages: plain server-rendered HTML at stable URLs, with no sign-in, no
// JavaScript and no PDF, so a store reviewer, a search engine or a person on any device can
// open them. They render the same document objects SeaYou renders, so the public text and the
// in-app text cannot drift apart.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A small, self-contained stylesheet: readable measure, generous spacing, dark and light both
// honoured, and a layout that works from a narrow phone upwards.
const STYLE = `
:root { color-scheme: light dark; --bg:#f7f9fa; --panel:#fff; --ink:#15242c; --muted:#4d6470;
  --line:#d8e2e6; --accent:#0d6e7d; }
@media (prefers-color-scheme: dark) { :root { --bg:#081925; --panel:#0d2231; --ink:#e7f0ee;
  --muted:#9fb5bf; --line:#1d3a4b; --accent:#7fd4d8; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 system-ui,-apple-system,
  "Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width: 44rem; margin:0 auto; padding: 1.5rem 1.15rem 4rem; }
header.site { border-bottom:1px solid var(--line); margin-bottom:1.5rem; padding-bottom:1rem; }
ul.docs { display:flex; flex-wrap:wrap; gap:.35rem .9rem; margin:.6rem 0 0; padding:0; list-style:none; }
ul.docs li { margin:0; }
ul.docs a { color:var(--accent); text-decoration:none; font-size:.94rem; }
ul.docs a:hover, ul.docs a:focus { text-decoration:underline; }
ul.docs a[aria-current="page"] { font-weight:600; text-decoration:underline; }
h1 { font-size:1.6rem; line-height:1.25; margin:0 0 .35rem; }
h2 { font-size:1.18rem; line-height:1.35; margin:2rem 0 .5rem; }
h3 { font-size:1.05rem; margin:1.4rem 0 .4rem; }
p, li { margin:0 0 .8rem; }
ul, ol { padding-left:1.4rem; }
.meta { color:var(--muted); font-size:.9rem; margin:0; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px;
  padding:1.1rem 1.15rem; margin:1.2rem 0; }
label { display:block; font-weight:600; margin:.9rem 0 .3rem; }
input[type=text], input[type=password] { width:100%; padding:.6rem .7rem; font:inherit;
  color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:8px; }
.check { display:flex; gap:.6rem; align-items:flex-start; font-weight:400; margin:1rem 0; }
.check input { margin-top:.35rem; flex:none; width:1.1rem; height:1.1rem; }
button { margin-top:1rem; width:100%; padding:.75rem 1rem; font:inherit; font-weight:600;
  color:#fff; background:#b3372f; border:0; border-radius:999px; cursor:pointer; }
button:hover { background:#992f28; }
.notice { border-left:4px solid var(--accent); padding:.6rem .9rem; background:var(--panel);
  border-radius:0 8px 8px 0; margin:1rem 0; }
.error { border-left-color:#b3372f; }
footer.site { border-top:1px solid var(--line); margin-top:2.5rem; padding-top:1rem;
  color:var(--muted); font-size:.88rem; }
a { color:var(--accent); }
@media (min-width: 40rem) { .wrap { padding-top:2.5rem; } h1 { font-size:1.9rem; } }
.address { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem; margin:.4rem 0 0; }
.address code { font-size:1.02rem; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:.35rem .55rem;
  user-select:all; -webkit-user-select:all; word-break:break-all; }
.mail-btn { display:inline-block; padding:.7rem 1.1rem; border-radius:999px; font-weight:600;
  text-decoration:none; color:#fff; background:var(--accent); }
.mail-btn:hover, .mail-btn:focus { filter:brightness(1.08); text-decoration:none; }
@media (prefers-color-scheme: dark) { .mail-btn { color:#06222c; } }
ul.cats { list-style:none; padding:0; margin:.6rem 0 0; display:grid; gap:.7rem; }
ul.cats li { margin:0; border:1px solid var(--line); border-radius:10px; padding:.7rem .85rem;
  background:var(--panel); }
ul.cats a { font-weight:600; }
ul.cats p { margin:.2rem 0 0; color:var(--muted); font-size:.92rem; }
.warn { border-left:4px solid #b3372f; background:var(--panel); border-radius:0 8px 8px 0;
  padding:.75rem .95rem; margin:1.2rem 0; }
.warn ul { margin:.4rem 0 0; }
@media (min-width: 40rem) { ul.cats { grid-template-columns:1fr 1fr; } }
`;

function nav(currentSlug: string): string {
  const items = [
    ...PUBLISHED_DOCUMENTS.map((d) => ({ href: `/legal/${d.slug}`, slug: d.slug, title: d.title })),
    { href: '/legal/delete-account', slug: 'delete-account', title: 'Delete your account' },
    { href: '/support', slug: 'support', title: 'Support' },
  ];
  return `<nav aria-label="Legal and support"><ul class="docs">${items
    .map(
      (i) =>
        `<li><a href="${i.href}"${
          i.slug === currentSlug ? ' aria-current="page"' : ''
        }>${esc(i.title)}</a></li>`,
    )
    .join('')}</ul></nav>`;
}

export function page(options: {
  title: string;
  description: string;
  slug: string;
  body: string;
  robots?: string;
}): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(options.description)}">
<meta name="robots" content="${options.robots ?? 'index, follow'}">
<title>${esc(options.title)} — SeaYou</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header class="site">
<p class="meta">SeaYou</p>
${nav(options.slug)}
</header>
<main>
${options.body}
</main>
<footer class="site">
<p>These pages are published for SeaYou and are available without signing in.</p>
</footer>
</div>
</body>
</html>`;
}

function renderBlock(b: PolicyBlock): string {
  switch (b.type) {
    case 'h2':
      return `<h2>${esc(b.text)}</h2>`;
    case 'h3':
      return `<h3>${esc(b.text)}</h3>`;
    case 'p':
      return `<p>${esc(b.text)}</p>`;
    case 'ul':
      return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`;
  }
}

export function documentPage(doc: PolicyDocument): string {
  return page({
    title: doc.title,
    description: doc.summary,
    slug: doc.slug,
    body: `<h1>${esc(doc.title)}</h1>
<p class="meta">Version ${esc(doc.version)} · ${esc(doc.effective)}</p>
${doc.blocks.map(renderBlock).join('\n')}`,
  });
}

// ---------- the account-deletion page ----------

const WHAT_HAPPENS = `<h2>What deleting your account does</h2>
<p>Deletion is immediate and cannot be undone. When you confirm:</p>
<ul>
<li>Every signed-in session ends at once, and the account can no longer sign in.</li>
<li>Your username, display name, email address, password, reset links, chosen harbour, time zone and preferences are removed.</li>
<li>Your friendships, friend requests, blocks and notifications are removed, so the account leaves other people's lists and no longer appears anywhere in SeaYou.</li>
<li>The letters you received are removed from your shore and archive, and any letter you had not yet sent is removed.</li>
<li>The text of every letter you wrote is erased — including letters already delivered — and letters still at sea or adrift in the public ocean are cancelled, so nobody can find or open them afterwards.</li>
</ul>
<h2>What remains for a limited time, and why</h2>
<ul>
<li>Letters other people wrote to you stay in their own Sent history, which belongs to them. You are shown there as “Deleted user”.</li>
<li>A minimal record that the account existed remains, with no personal details, together with minimal anonymous audit records.</li>
<li>If one of your letters was reported, its evidence copy is kept for the rest of its 30-day retention period, until an appeal filed in time is decided, or while a documented legal or child-safety hold requires it, and is then removed. It is not used for anything else.</li>
<li>Backups may still hold information for a limited recovery period before they are overwritten.</li>
<li>Copies another person made outside SeaYou cannot be reached or deleted by SeaYou.</li>
</ul>`;

export function deletionPage(options: {
  error?: string | undefined;
  username?: string | undefined;
}): string {
  const error = options.error
    ? `<div class="notice error" role="alert"><p>${esc(options.error)}</p></div>`
    : '';
  return page({
    title: 'Delete your account',
    description:
      'Delete your account of SeaYou and its associated data, without reinstalling SeaYou.',
    slug: 'delete-account',
    body: `<h1>Delete your account</h1>
<p>You can delete your account here, or from <strong>Settings → Delete account</strong> inside SeaYou. Both do exactly the same thing.</p>
${WHAT_HAPPENS}
<div class="card">
<h2>Delete this account</h2>
<p>Sign in with the account you want to delete. Your password is asked for again so that nobody else can delete it.</p>
${error}
<form method="post" action="/legal/delete-account">
<label for="u">Username</label>
<input id="u" name="username" type="text" autocomplete="username" autocapitalize="none"
 autocorrect="off" spellcheck="false" required value="${esc(options.username ?? '')}">
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<label class="check" for="c">
<input id="c" name="confirm" type="checkbox" value="yes" required>
<span>I understand that deleting my account is permanent and cannot be undone.</span>
</label>
<button type="submit">Permanently delete my account</button>
</form>
</div>`,
  });
}

// An unknown address under /legal gets a page, not an API error body: these are the URLs store
// reviewers and regulators follow (audit FE-018).
export function notFoundPage(): string {
  return page({
    title: 'Page not found',
    description: 'This SeaYou legal page does not exist.',
    slug: '',
    robots: 'noindex',
    body: `<h1>Page not found</h1>
<p>There is no document at this address. Every published document is listed on the <a href="/legal">Legal and safety</a> page.</p>`,
  });
}

export function deletionDonePage(): string {
  return page({
    title: 'Account deleted',
    description: 'The account and its associated data have been deleted.',
    slug: 'delete-account',
    body: `<h1>Your account has been deleted</h1>
<div class="notice"><p>The account is gone and every session has ended. You can close this page.</p></div>
${WHAT_HAPPENS}
<p>If you want to use SeaYou again, you are welcome to create a new account at any time.</p>`,
  });
}

// ---------- the public support page ----------

// Support is a published e-mail address and nothing more: no form, no inbox integration, no
// ticket store. The page therefore needs no JavaScript at all — every control is a `mailto:`
// link, and the address is shown as selectable text so it can be copied by hand on a device
// with no mail client configured.
export function supportPage(email: string): string {
  const categories = SUPPORT_CATEGORIES.map(
    (c) => `<li>
<a href="${esc(supportMailto(email, c.subject))}">${esc(c.label)}</a>
<p>${esc(c.hint)}</p>
</li>`,
  ).join('');

  return page({
    title: 'Support',
    description: `Contact ${SUPPORT_NAME} about SeaYou: account help, privacy requests, safety reports and technical problems.`,
    slug: 'support',
    body: `<h1>Support</h1>
<p>${esc(SUPPORT_NAME)} answers questions about SeaYou — your account, your privacy, safety concerns and anything that is not working.</p>

<div class="card">
<h2>Contact ${esc(SUPPORT_NAME)}</h2>
<p class="address">
<a class="mail-btn" href="${esc(supportMailto(email, `${SUPPORT_NAME} — Other`))}">Contact Support</a>
<code>${esc(email)}</code>
</p>
<p class="meta">If your device cannot open an email client, select the address above and copy it into the mail app you use.</p>
</div>

<h2>What are you writing about?</h2>
<p>Each heading opens a message to the same address with the subject filled in, so it reaches the right place faster. You can also write without choosing one.</p>
<ul class="cats">${categories}</ul>

<div class="warn">
<p><strong>Never send these to support, or to anyone claiming to be support:</strong></p>
<ul>${SUPPORT_NEVER_SEND.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
<p class="meta">Support will never ask you for any of them. A message that does is not from us.</p>
</div>

<h2>Reporting something inside SeaYou</h2>
<p>If a letter you can read breaks the rules, reporting it from the reader is faster than writing here: it opens a case an administrator reviews, and it hides the letter from your account straight away. If a person may be in immediate danger, contact your local emergency service first — SeaYou is not an emergency service.</p>

<h2>Documents</h2>
<ul>
${PUBLISHED_DOCUMENTS.map((d) => `<li><a href="/legal/${d.slug}">${esc(d.title)}</a> — ${esc(d.summary)}</li>`).join('\n')}
<li><a href="/legal/delete-account">Delete your account</a> — remove your account and its associated data without reinstalling SeaYou.</li>
</ul>`,
  });
}
