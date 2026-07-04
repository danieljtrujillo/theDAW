import React from 'react';

/**
 * Collaborator credit. A short lead line plus a row of branded link chips,
 * rendered a touch more prominently than a plain byline (bordered pills, brand
 * colors, 9px mono). Placed in-context per feature: InfiNight on Perform + DJ,
 * dadabots on Underfit, skreambot on Foundry. Call sites position the wrapper
 * (a footer strip or a corner overlay) via `className`.
 */
export interface CreditLink {
  /** Visible chip label, e.g. "SoundCloud". */
  label: string;
  href: string;
  /** Tailwind text-color class for the chip (brand hue). */
  color: string;
}

export const Credit: React.FC<{ lead: string; links: CreditLink[]; className?: string }> = ({
  lead,
  links,
  className,
}) => (
  <div className={`flex items-center flex-wrap gap-x-2 gap-y-1 ${className ?? ''}`}>
    <span className="text-[9px] font-mono text-zinc-400">{lead}</span>
    <div className="flex items-center flex-wrap gap-1">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          title={`${l.label} — opens in a new tab`}
          className={`rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-mono transition-colors hover:border-white/25 hover:bg-white/10 ${l.color}`}
        >
          {l.label}
        </a>
      ))}
    </div>
  </div>
);

/* ── Configured credits ───────────────────────────────────────────────────── */

const INFINIGHT_LINKS: CreditLink[] = [
  { label: 'SoundCloud', href: 'https://soundcloud.com/infinight', color: 'text-orange-300' },
  { label: 'Instagram', href: 'https://www.instagram.com/infinightpath/', color: 'text-pink-300' },
  { label: 'GitHub', href: 'https://github.com/morganlavery', color: 'text-zinc-300' },
];

/** Perform + DJ are adapted from InfiNight's fork of theDAW. `feature` names
 *  the surface ("Perform" / "DJ"). */
export const InfiNightCredit: React.FC<{ feature: string; className?: string }> = ({ feature, className }) => (
  <Credit
    lead={`${feature} adapted from InfiNight's fork of theDAW`}
    links={INFINIGHT_LINKS}
    className={className}
  />
);

const DADABOTS_LINKS: CreditLink[] = [
  { label: 'Website', href: 'https://dadabots.com', color: 'text-teal-300' },
  { label: 'Spotify', href: 'https://open.spotify.com/artist/0aB11GHSm0a5ntDOROj32V', color: 'text-green-300' },
  { label: 'Instagram', href: 'https://www.instagram.com/dadabots_/', color: 'text-pink-300' },
  { label: 'GitHub', href: 'https://github.com/dada-bots', color: 'text-zinc-300' },
];

/** The Underfit LoRA trainer is built by dadabots. */
export const DadabotsCredit: React.FC<{ className?: string }> = ({ className }) => (
  <Credit lead="Underfit trainer by dadabots" links={DADABOTS_LINKS} className={className} />
);

const SKREAMBOT_LINKS: CreditLink[] = [
  { label: 'Spotify', href: 'https://open.spotify.com/artist/4q5n0QgK6mvyuw8FRzhuNA', color: 'text-green-300' },
  { label: 'Suno', href: 'https://suno.com/@skreamb0t', color: 'text-violet-300' },
  { label: 'Instagram', href: 'https://www.instagram.com/starman.josh/', color: 'text-pink-300' },
  { label: 'Devpost', href: 'https://devpost.com/ycskream', color: 'text-sky-300' },
  { label: 'GitHub', href: 'https://github.com/StarskreamEXE', color: 'text-zinc-300' },
];

/** skreambot (Josh) credit, shown on the Foundry tab. */
export const SkreambotCredit: React.FC<{ className?: string }> = ({ className }) => (
  <Credit lead="skreambot" links={SKREAMBOT_LINKS} className={className} />
);
