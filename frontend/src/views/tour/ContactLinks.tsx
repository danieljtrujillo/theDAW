/** Every contact/social channel a venue carries, as icon links. */
import React from 'react';
import {
  Facebook,
  Globe,
  Instagram,
  Mail,
  MessageCircle,
  Music2,
  Music4,
  Phone,
  Twitter,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import type { TourVenue } from '../../lib/tourClient';

// An OSM contact tag may be a full URL or a bare handle; normalize to a URL.
const handleUrl = (host: string, v: string): string =>
  /^https?:\/\//i.test(v) ? v : `https://${host}/${v.replace(/^@/, '')}`;

// Every contact channel a venue can carry, in a stable render order. `external`
// links open in a new tab; tel:/mailto: navigate in place.
const CONTACT_CHANNELS: Array<{
  key: keyof TourVenue;
  icon: LucideIcon;
  label: string;
  href: (v: string) => string;
  external: boolean;
}> = [
  { key: 'website', icon: Globe, label: 'Website', href: (v) => v, external: true },
  { key: 'email', icon: Mail, label: 'Email', href: (v) => `mailto:${v}`, external: false },
  { key: 'phone', icon: Phone, label: 'Call', href: (v) => `tel:${v}`, external: false },
  { key: 'whatsapp', icon: MessageCircle, label: 'WhatsApp', href: (v) => `https://wa.me/${v.replace(/[^0-9]/g, '')}`, external: true },
  { key: 'instagram', icon: Instagram, label: 'Instagram', href: (v) => handleUrl('instagram.com', v), external: true },
  { key: 'facebook', icon: Facebook, label: 'Facebook', href: (v) => handleUrl('facebook.com', v), external: true },
  { key: 'twitter', icon: Twitter, label: 'X / Twitter', href: (v) => handleUrl('x.com', v), external: true },
  { key: 'youtube', icon: Youtube, label: 'YouTube', href: (v) => handleUrl('youtube.com', v), external: true },
  { key: 'tiktok', icon: Music2, label: 'TikTok', href: (v) => handleUrl('tiktok.com', v), external: true },
  { key: 'soundcloud', icon: Music4, label: 'SoundCloud', href: (v) => handleUrl('soundcloud.com', v), external: true },
  { key: 'bandcamp', icon: Music4, label: 'Bandcamp', href: (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`), external: true },
  { key: 'spotify', icon: Music4, label: 'Spotify', href: (v) => v, external: true },
];

/** `max` caps how many icons a compact list row shows; the detail card and
 *  the route list show every channel. */
export const ContactLinks: React.FC<{ v: TourVenue; max?: number }> = ({ v, max }) => {
  const present = CONTACT_CHANNELS.filter(({ key }) => {
    const value = v[key];
    return typeof value === 'string' && value.length > 0;
  });
  const shown = max ? present.slice(0, max) : present;
  if (shown.length === 0) return null;
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1">
      {shown.map(({ key, icon: Icon, label, href, external }) => (
        <a
          key={key}
          href={href(v[key] as string)}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          aria-label={`${label} for ${v.name}`}
          title={label}
          className="text-zinc-500 hover:text-lime-300"
        >
          <Icon className="h-3 w-3" />
        </a>
      ))}
    </span>
  );
};
