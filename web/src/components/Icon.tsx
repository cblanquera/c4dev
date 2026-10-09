/** Shared Lucide profile: 24-unit grid, round 2-unit strokes and inherited color. */
import {
  ArrowLeft, ArrowRight, Check, Circle, CircleAlert, CircleCheck, CircleHelp,
  CircleX, CornerDownRight, ChevronDown, ChevronRight, Hash, ImagePlus, KeyRound,
  LoaderCircle, Maximize2, Minimize2, Plus, RotateCcw, Settings, Sparkles, Square, Terminal, X,
} from 'lucide-react';

const ICONS = {
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  check: Check,
  circle: Circle,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-help': CircleHelp,
  'circle-x': CircleX,
  'corner-down-right': CornerDownRight,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  hash: Hash,
  'image-plus': ImagePlus,
  'key-round': KeyRound,
  'loader-circle': LoaderCircle,
  'maximize-2': Maximize2,
  'minimize-2': Minimize2,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  terminal: Terminal,
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
