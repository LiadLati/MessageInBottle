import { SUPPORT_PATH } from '@mib/shared';

// Help & Support always leaves SeaYou for the public support page, in a new tab. That is what
// makes it reachable from every state: it is an ordinary link to a server-rendered page, so it
// does not touch the navigation, the policy-acceptance gate, or a suspended account's
// restrictions, and it cannot lose whatever the person was in the middle of.
export function SupportLink({
  className = 'btn-text',
  label = 'Help & Support',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <a className={className} href={SUPPORT_PATH} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}
