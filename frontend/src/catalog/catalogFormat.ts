/**
 * catalogFormat — tiny shared formatters used across every Catalogue surface
 * (list rows, grid cards, inspector). Kept in one place so List/Grid/Inspector
 * always render durations/dates/sizes identically.
 */

/** "3:07" from seconds. Returns "--:--" for missing/invalid values. */
export const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Locale date string from an ISO timestamp; falls back to the raw string. */
export const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

/** Human byte size: "4.2 MB" / "812 KB" / "44 B". */
export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
