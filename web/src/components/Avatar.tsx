/** A profile picture, or initials in the name's own color when there's none. Decorative: the name is always shown beside it. */
import type { CSSProperties } from 'react';
import { agentColor } from '../agent-colors.ts';

export function Avatar({ name, imageUrl, size = 32 }: { name: string; imageUrl: string | null; size?: number }) {
  const color = agentColor(name);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4), '--agent-light': color.light, '--agent-dark': color.dark } as CSSProperties;
  return imageUrl
    ? <img className="avatar" src={imageUrl} alt="" width={size} height={size} style={style} />
    : <span className="avatar avatar-initials" aria-hidden="true" style={style}>{initials}</span>;
}
