import { Atom, FlaskConical, Lightbulb } from 'lucide-react';
import type { PrimaryAgentAvatar } from '@openlab/protocol';

interface AgentAvatarProps {
  avatar: PrimaryAgentAvatar;
  size?: 'tiny' | 'small' | 'medium' | 'large';
}

export function AgentAvatar({ avatar, size = 'medium' }: AgentAvatarProps) {
  const custom = /^data:image\/(?:png|jpeg|webp);base64,/u.test(avatar);
  const icon = avatar === 'ocean'
    ? <FlaskConical/>
    : avatar === 'amber'
      ? <Lightbulb/>
      : <Atom/>;
  return <span className={`agent-avatar-visual ${size}`} data-avatar={custom ? 'custom' : avatar} aria-hidden="true">{custom ? <img src={avatar} alt="" draggable={false}/> : icon}</span>;
}
