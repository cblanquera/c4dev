/** The same name keeps its approved theme-aware color across jobs and views; a profile picture shows beside it. */
import type { CSSProperties } from 'react';
import type { Subtask } from '../../../server/types.ts';
import { agentColor } from '../agent-colors.ts';
import { useAgent } from '../agents.ts';
import { Avatar } from './Avatar.tsx';

interface Props {
  actor: string;
  subtask?: Subtask;
  profileId?: number | null;
  as?: 'strong' | 'span';
  className?: string;
  /** Show the profile picture (or initials) before the name. */
  avatar?: boolean;
}

export function AgentName({ actor, subtask, profileId, as: Tag = 'strong', className = '', avatar = false }: Props) {
  const agent = useAgent(actor, { subtask, profileId });
  const color = agentColor(agent.name);
  const style = { '--agent-light': color.light, '--agent-dark': color.dark } as CSSProperties;
  return (
    <Tag className={`agent-name ${avatar ? 'with-avatar' : ''} ${className}`} style={style} data-agent-color={color.key} title={actor}>
      {avatar && <Avatar name={agent.name} imageUrl={agent.imageUrl} size={20} />}
      {agent.name} · {agent.title}
    </Tag>
  );
}
