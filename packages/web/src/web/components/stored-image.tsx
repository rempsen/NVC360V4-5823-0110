import { useState } from "react";

/**
 * An <img> for user-uploaded / object-storage URLs, with a real fallback.
 *
 * Why this exists: stored image references can dangle — an object can be
 * removed from the bucket, restored from a different environment, or copied
 * between tenants, while the DB row still points at the old key. When that
 * happened the raw <img> rendered the browser's broken-image glyph and logged
 * a 404 to the console on every page load (seen on /admin/catalog). Callers
 * already have a nice placeholder for "no image"; this makes "image is gone"
 * look the same as "no image" instead of looking like a broken page.
 */
export function StoredImage({
  src,
  alt = "",
  className,
  fallback = null,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
  /** rendered when there is no src, or the src fails to load */
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
