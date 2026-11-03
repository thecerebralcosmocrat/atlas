import { cva } from 'class-variance-authority';
import { Icon, FailedMark, Pending, Success, Waiting, Warning } from '@/components/glaze/icon';
import {cn} from '@/lib/glaze/utils';

const statuses = ['idle', 'queued', 'running', 'ok', 'warn', 'fail', 'waiting'];

const statusLabels = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  ok: 'Passed',
  warn: 'Warning',
  fail: 'Failed',
  waiting: 'Waiting on you',
};

/** Severity for sorting a status column: fail first, then what waits on a person, idle last. Higher is worse. */
const statusRank = {fail: 6, waiting: 5, warn: 4, running: 3, queued: 2, ok: 1, idle: 0};

/** ok, warn and fail end a piece of work, and waiting stops it on a person; the others are on the way. */
const settled = (status) => status === 'ok' || status === 'warn' || status === 'fail' || status === 'waiting';

// items-baseline gives the Status the word's baseline, so it lines up with text beside it; the mark keeps to the first line.
const statusVariants = cva('inline-flex max-w-full min-w-0 items-baseline gap-1 data', {
  variants: {
    size: {
      default: 'type-label',
      sm: 'type-label-sm',
    },
    status: {
      idle: 'text-text-2',
      queued: 'text-text-2',
      running: 'text-text-1',
      ok: 'text-ok-text',
      warn: 'text-warn-text',
      fail: 'text-fail-text',
      waiting: 'text-text-1',
    },
  },
  defaultVariants: {size: 'default', status: 'idle'},
});

/** The glyph for each status; queued and idle have none. */
const statusGlyph = {
  idle: null,
  queued: null,
  running: Pending,
  ok: Success,
  warn: Warning,
  fail: FailedMark,
  waiting: Waiting,
};

function Status({
  status = 'idle',
  size = 'default',
  live,
  className,
  children,
  ...props
}) {
  const word = children ?? statusLabels[status];
  return <span
    data-slot="status"
    data-status={status}
    data-size={size}
    className={cn(statusVariants({size, status}), className)}
    {...props}
  >
    <StatusMark status={status}/>
    <span data-slot="status-word" aria-hidden={live && settled(status) ? true : undefined} className="min-w-0 [overflow-wrap:anywhere]">{word}</span>
    {/* The region is always in the DOM, so a change from empty to the word is what gets announced. */}
    {live && <span role="status" className="sr-only">{settled(status) ? (typeof word === 'string' ? word : statusLabels[status]) : ''}</span>}
  </span>;
}

/**
 * The glyph on its own, one line tall, for a dense spot beside a word that already names the status. Pass label when
 * nothing beside it does, so it is announced; without one it is hidden from assistive tech. Queued and idle draw
 * nothing, so a lone one keeps only its label, for a screen reader.
 */
function StatusMark({
  status = 'idle',
  label,
  className,
  ...props
}) {
  const glyph = statusGlyph[status];
  if (!glyph) return label ? <span data-slot="status-mark" data-status={status} className="sr-only">{label}</span> : null;
  return <span
    data-slot="status-mark"
    data-status={status}
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    className={cn('flex h-lh shrink-0 items-center self-start', className)}
    {...props}
  >
    <Icon icon={glyph} size={12} weight={status === 'running' ? 'regular' : 'bold'} className={cn(status === 'running' && 'animate-spin motion-reduce:animate-none')}/>
  </span>;
}

export { Status, StatusMark, statusVariants, statusGlyph, statuses, statusLabels, statusRank };
