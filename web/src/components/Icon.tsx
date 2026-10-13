/** Shared Lucide profile: 24-unit grid, round 2-unit strokes and inherited color. */
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, Bell, GitMerge, Check, Circle, CircleAlert, CircleCheck, CircleHelp,
  CircleX, Copy, CornerDownRight, ChevronDown, ChevronRight, Hash, ImagePlus, Kanban, KeyRound, Link, Unlink,
  LoaderCircle, Maximize2, Minimize2, Plug, Plus, RotateCcw, Settings, Sparkles, Square, Terminal, Trash2, X,
} from 'lucide-react';

const ICONS = {
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up-from-line': ArrowUpFromLine,
  'git-merge': GitMerge,
  bell: Bell,
  check: Check,
  circle: Circle,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-help': CircleHelp,
  'circle-x': CircleX,
  copy: Copy,
  'corner-down-right': CornerDownRight,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  hash: Hash,
  'image-plus': ImagePlus,
  kanban: Kanban,
  'key-round': KeyRound,
  link: Link,
  'loader-circle': LoaderCircle,
  'maximize-2': Maximize2,
  'minimize-2': Minimize2,
  plug: Plug,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  terminal: Terminal,
  trash: Trash2,
  unlink: Unlink,
  x: X,
};

interface Props {
  name: keyof typeof ICONS;
  size?: 12 | 14 | 16;
  className?: string;
}

/** Decorative geometry; labels and meaningful status names belong to the host. */
export function Icon({ name, size = 16, className = '' }: Props) {
  const Glyph = ICONS[name];
  return (
    <Glyph className={`icon ${className}`} size={size} strokeWidth={2} color="currentColor" aria-hidden="true" focusable="false" />
  );
}
