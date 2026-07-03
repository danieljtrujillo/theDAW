/**
 * Brand lockup — "VST FOUNDRY / by StarskreamEXE".
 *
 * Self-contained title module. Drop this whole `brand-title/` folder into any
 * React app and import the component. Everything it needs lives alongside it:
 *   ./BrandTitle.css            — all styles + animations
 *   ./assets/brand-icon.png     — robot head (tinted via CSS mask, any color)
 *   ./assets/fonts/press-start-2p.woff2 — pixel font for the small word
 *
 * Layout: the pixel word floats above the main word, overlapping it slightly;
 * the byline ("by …", any "0" in it gets an animated gradient) hangs underneath.
 * Hover: the head wiggles madly with a red outline; the pixel word nudges up.
 *
 * See README.md for how to recolor, rename, resize, and retheme.
 */
import "./BrandTitle.css";

export default function BrandTitle({
  pixelWord = "better",
  mainWord = "CLAUDE CODE",
  byline = "StarskreamEXE",
  variant = "default",
  iconOnly = false,
}: {
  /** Small pixel-font word floating above the title. */
  pixelWord?: string;
  /** The big uppercase title. */
  mainWord?: string;
  /**
   * Text after "by". The single "0" inside it gets the animated gradient,
   * so a byline containing a "0" lights up automatically.
   */
  byline?: string;
  /** "purple" tints the robot icon purple instead of the default ink color. */
  variant?: "default" | "purple";
  /** Render just the robot icon (e.g. a collapsed rail). */
  iconOnly?: boolean;
}) {
  const className = [
    "brand",
    variant === "purple" ? "brand--purple" : "",
    iconOnly ? "brand--iconOnly" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Split the byline so a literal "0" can be wrapped for the gradient animation.
  const zeroIndex = byline.indexOf("0");
  const before = zeroIndex >= 0 ? byline.slice(0, zeroIndex) : byline;
  const after = zeroIndex >= 0 ? byline.slice(zeroIndex + 1) : "";

  return (
    <div className={className}>
      <span className="brandImg" aria-hidden="true" />
      {!iconOnly && (
        <div className="brandText">
          <span className="brandPixel">{pixelWord}</span>
          <h1 className="brandTitle">{mainWord}</h1>
          <span className="brandBy">
            by {before}
            {zeroIndex >= 0 && <span className="brandZero">0</span>}
            {after}
          </span>
        </div>
      )}
    </div>
  );
}
