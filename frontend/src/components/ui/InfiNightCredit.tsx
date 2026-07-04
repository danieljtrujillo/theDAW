import React from 'react';

/**
 * Attribution credit. The Perform and DJ workspaces are adapted from
 * InfiNight's fork of theDAW; this renders the inline credit line with links to
 * InfiNight. Call sites position it (a footer strip in Perform, a corner
 * overlay in DJ) via the wrapping element. `feature` names the surface
 * ("Perform" / "DJ").
 */
export const InfiNightCredit: React.FC<{ feature: string; className?: string }> = ({
  feature,
  className,
}) => (
  <div
    className={`flex items-center gap-2 text-[8px] font-mono text-zinc-500 ${className ?? ''}`}
  >
    <span>{feature} adapted from InfiNight&apos;s fork of theDAW</span>
    <a
      href="https://soundcloud.com/infinight"
      target="_blank"
      rel="noopener noreferrer"
      title="InfiNight on SoundCloud"
      className="text-sky-400/80 hover:text-sky-300 transition-colors"
    >
      SoundCloud
    </a>
    <span className="text-zinc-700">&middot;</span>
    <a
      href="https://www.instagram.com/infinightpath/"
      target="_blank"
      rel="noopener noreferrer"
      title="InfiNight on Instagram"
      className="text-sky-400/80 hover:text-sky-300 transition-colors"
    >
      Instagram
    </a>
    <span className="text-zinc-700">&middot;</span>
    <a
      href="https://github.com/morganlavery"
      target="_blank"
      rel="noopener noreferrer"
      title="InfiNight on GitHub"
      className="text-sky-400/80 hover:text-sky-300 transition-colors"
    >
      GitHub
    </a>
  </div>
);
