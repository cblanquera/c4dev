/**
 * The factory's mark, and a project's logo: its uploaded image or linked URL,
 * falling back to the factory's mark when there's none or it fails to load.
 */
import { useEffect, useState } from 'react';

export const FactoryLogo = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Software Factory"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22V12l5 3v-3l5 3v-3l6 4v6z" fill="white" /></svg>
);

export function ProjectLogo({ url, name, size = 22 }: { url: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [url]);
  if (!url || broken) return <FactoryLogo size={size} />;
  return <img className="project-logo" src={url} alt={`${name} logo`} width={size} height={size} onError={() => setBroken(true)} />;
}
