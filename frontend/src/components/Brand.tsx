/**
 * The platform's mark and name, which used to head the page from a header bar
 * of their own. That bar is gone -- it was a whole row of height for a logo,
 * a search box the agent panel now does better, and an avatar -- so the brand
 * lives where the eye starts instead: at the top of the side panel, or at the
 * start of the strip while the panel is hidden. Either way it takes you home.
 */

export interface BrandInfo {
  title: string;
  logoUrl: string | null;
}

/** The logo, or the title's first letter on a tile when none is set, so the
 * strip always has something to show where the logo goes. */
export function BrandMark({ brand, size = 22 }: { brand: BrandInfo; size?: number }) {
  if (brand.logoUrl) {
    return <img className="brand-logo" src={brand.logoUrl} alt="" style={{ width: size, height: size }} />;
  }
  return (
    <span className="brand-initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }} aria-hidden>
      {brand.title.trim().charAt(0).toUpperCase() || "·"}
    </span>
  );
}
