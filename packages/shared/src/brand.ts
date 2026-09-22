// The public product name, in one place so the documents, the pages, the app shell and the
// tests that police them cannot drift apart.
//
// This is the *product* name only. Repository paths, package names (`@mib/…`), database
// identifiers, environment variables (`MIB_…`) and internal namespaces are deliberately left
// alone: renaming them would churn every import and migration without changing anything a
// person ever sees.
export const PRODUCT_NAME = 'SeaYou';

// Phrases that must never reach a rendered page again: the placeholder the documents used
// before the product had a name, and the old spelling of the support identity.
export const RETIRED_PRODUCT_PHRASES = [
  'the App',
  'The App',
  'Message in a Bottle',
  'Sea You Support',
] as const;
