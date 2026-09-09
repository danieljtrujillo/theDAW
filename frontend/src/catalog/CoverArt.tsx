import React, { useEffect, useState } from 'react';
import { Music } from 'lucide-react';

interface Props {
  /** `entry.coverUrl` — null/undefined for a track whose file carried no art. */
  coverUrl?: string | null;
  /** The album/track name. Becomes the image's alt text, so it says what the
   *  picture IS rather than that it is a picture. */
  title: string;
  /** Sizing/shape for the box, applied to both the image and the placeholder
   *  so a rail of mixed entries stays on one grid. */
  className?: string;
  /** Placeholder glyph size, matched to whatever the surface used before. */
  iconClassName?: string;
}

/**
 * A library entry's cover art, with the app's own placeholder behind it.
 *
 * The image is lazy — a library of hundreds of entries only fetches the covers
 * that actually scroll into view. A cover that 404s (deleted on disk between
 * the list response and the render) falls back to the same placeholder instead
 * of leaving the browser's broken-image glyph in the grid.
 */
export const CoverArt: React.FC<Props> = ({
  coverUrl,
  title,
  className = '',
  iconClassName = 'w-6 h-6',
}) => {
  const [failed, setFailed] = useState(false);
  // Every cover URL carries the file's mtime, so refreshing an entry's art
  // hands this component a URL it has never tried. Clear the failure so the
  // new one gets its own attempt instead of inheriting the old one's verdict.
  useEffect(() => setFailed(false), [coverUrl]);

  if (!coverUrl || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-black/40 ${className}`}
        aria-hidden="true"
      >
        <Music className={`${iconClassName} text-zinc-800`} />
      </div>
    );
  }
  return (
    <img
      src={coverUrl}
      alt={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`object-cover bg-black/40 ${className}`}
    />
  );
};
