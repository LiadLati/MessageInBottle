import { ICONS, type IconName } from './icons.generated.js';

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

// The 24x24 stroke icons from the design handoff, rendered inline so they inherit currentColor.
export function Icon({ name, size = 21, className, title }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + ICONS[name] }}
    />
  );
}

export type { IconName };
