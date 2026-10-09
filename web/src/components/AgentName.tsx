/** The same name keeps its approved theme-aware color across jobs and views. */
import type { CSSProperties } from 'react';
import type { Subtask } from '../../../server/types.ts';
import { agentColor } from '../agent-colors.ts';
import { agentProfile } from '../agents.ts';

interface Props {
  actor: string;
  subtask?: Subtask;
  as?: 'strong' | 'span';
  className?: string;
}

export function AgentName({ actor, subtask, as: Tag = 'strong', className = '' }: Props) {
  const profile = agentProfile(actor, subtask);
  const color = agentColor(profile.name);
  const style = { '--agent-light': color.light, '--agent-dark': color.dark } as CSSProperties;
  return <Tag className={`agent-name ${className}`} style={style} data-agent-color={color.key} title={actor}>{profile.name} · {profile.title}</Tag>;
}
