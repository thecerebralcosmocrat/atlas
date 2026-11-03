'use client';;
import { createContext, useContext } from 'react';
import {Progress as ProgressPrimitive} from '@base-ui/react/progress';
import {Meter as MeterPrimitive} from '@base-ui/react/meter';
import {Icon, FailedMark, Pending, Warning} from '@/components/glaze/icon';
import {cn, mergeClass} from '@/lib/glaze/utils';

const ProgressContext = createContext({mode: 'progress', indeterminate: false});

const statusWords = {warn: 'Near limit', fail: 'At limit'};

/** Which status a meter's fraction has reached. */
function meterStatus(fraction, warnAt, failAt) {
  if (failAt !== null && fraction >= failAt) return 'fail';
  if (warnAt !== null && fraction >= warnAt) return 'warn';
  return undefined;
}

function Progress({
  className,
  children,
  value = null,
  min = 0,
  max = 100,
  mode = 'progress',
  size = 'default',
  status: statusProp,
  warnAt = 0.8,
  failAt = 1,
  statusLabel,
  ...props
}) {
  const meter = mode === 'meter';
  const fraction = value === null ? null : Math.min(Math.max((value - min) / (max - min || 1), 0), 1);
  const status = statusProp ?? (meter && fraction !== null ? meterStatus(fraction, warnAt, failAt) : undefined);
  const indeterminate = !meter && fraction === null;
  const shared = {
    'data-slot': 'progress',
    'data-mode': mode,
    'data-size': size,
    'data-status': status,
    'data-indeterminate': indeterminate || undefined,
    locale: "en-US",
    // The status words join the reading a screen reader hears: "92%, Near limit".
    getAriaValueText: (formatted) => {
      const word = status ? (typeof statusLabel === 'string' ? statusLabel : statusWords[status]) : '';
      return [formatted ?? (indeterminate ? 'In progress' : ''), word].filter(Boolean).join(', ');
    },
  };
  const rootClass = 'group/progress flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2';
  const ticks = meter ? [warnAt, failAt].filter(t => t !== null && t > 0 && t < 1) : [];
  const track = <ProgressTrack meter={meter} size={size} ticks={ticks} filled={(fraction ?? 0) > 0}/>;
  const context = {mode, status, indeterminate, statusLabel};
  if (meter) return (
    <ProgressContext.Provider value={context}>
      <MeterPrimitive.Root value={value ?? 0} min={min} max={max} {...shared} className={mergeClass(rootClass, className)} {...(props)}>
        {children}{track}
      </MeterPrimitive.Root>
    </ProgressContext.Provider>
  );
  return <ProgressContext.Provider value={context}>
    <ProgressPrimitive.Root value={value} min={min} max={max} {...shared} className={mergeClass(rootClass, className)} {...props}>
      {children}{track}
    </ProgressPrimitive.Root>
  </ProgressContext.Provider>;
}

const trackHeight = {sm: 'h-(--progress-bar-sm)', default: 'h-(--progress-bar)', lg: 'h-(--progress-bar-lg)'};
// A fill shorter than the bar is thick would squash its round ends, so any value above zero shows at least a circle.
const fillMin = {sm: 'min-w-(--progress-bar-sm)', default: 'min-w-(--progress-bar)', lg: 'min-w-(--progress-bar-lg)'};

/** The track and its fill, from the start edge, with a tick at each meter threshold. */
function ProgressTrack({
  meter,
  size,
  ticks,
  filled
}) {
  const Track = meter ? MeterPrimitive.Track : ProgressPrimitive.Track;
  const Indicator = meter ? MeterPrimitive.Indicator : ProgressPrimitive.Indicator;
  return (
    <span data-slot="progress-bar" className="relative block w-full basis-full">
      <Track
        data-slot="progress-track"
        className={cn(
          'relative block w-full overflow-hidden rounded-pill bg-field forced-colors:outline forced-colors:outline-1',
          // The hairline inside the edge, drawn over the fill so the bar keeps one outline at any value.
          'after:pointer-events-none after:absolute after:inset-0 after:rounded-pill after:border after:border-line-faint',
          trackHeight[size],
        )}
      >
        <Indicator
          data-slot="progress-indicator"
          className={cn(
            'glaze-sm glaze-sm-x block h-full rounded-pill transition-[width] duration-(--dur-state) ease-out motion-reduce:transition-none',
            'forced-colors:bg-[CanvasText]',
            // Past a threshold the fill takes the status colour, flat, and keeps the top highlight; the dark rim goes.
            'group-data-status/progress:[--glaze-sm-rim:transparent]',
            'group-data-[status=warn]/progress:bg-none group-data-[status=warn]/progress:bg-warn',
            'group-data-[status=fail]/progress:bg-none group-data-[status=fail]/progress:bg-fail',
            'group-data-indeterminate/progress:hidden',
            filled && fillMin[size],
          )}
        />
        {!meter && <span
          aria-hidden
          data-slot="progress-sweep"
          className={cn(
            'glaze-sm glaze-sm-x absolute inset-y-0 hidden w-(--progress-sweep) rounded-pill group-data-indeterminate/progress:block',
            'animate-sweep motion-reduce:start-0 motion-reduce:w-1/2 motion-reduce:animate-none',
            'forced-colors:bg-[CanvasText]',
          )}
        />}
      </Track>
      {ticks.map(t => <span
        key={t}
        aria-hidden
        data-slot="progress-tick"
        className="absolute -inset-y-0.5 start-(--at) w-px -translate-x-1/2 rounded-pill bg-line-strong rtl:translate-x-1/2"
        style={{
          '--at': `${t * 100}%`
        }}
      />)}
    </span>
  );
}

/** The name of what is progressing or measured, on the left of the row above the bar. */
function ProgressLabel({
  className,
  ...props
}) {
  const {mode} = useContext(ProgressContext);
  const Label = mode === 'meter' ? MeterPrimitive.Label : ProgressPrimitive.Label;
  return <Label data-slot="progress-label" className={mergeClass('min-w-0 flex-1 truncate type-label text-text-1', className)} {...(props)}/>;
}

const statusGlyph = {warn: Warning, fail: FailedMark};

/**
 * The reading on the right of the row above the bar, in tabular figures. Past a threshold a glyph and the status
 * words in the status colour come before it. While indeterminate it is empty, or the still arc under reduced motion.
 */
function ProgressValue({
  className,
  children,
  ...props
}) {
  const {mode, status, indeterminate, statusLabel} = useContext(ProgressContext);
  const cls = cn('ms-auto inline-flex shrink-0 items-center gap-2 type-caption text-text-2 data', className);
  const words = status ? <span data-slot="progress-status" className={cn('inline-flex items-center gap-1', status === 'fail' ? 'text-fail-text' : 'text-warn-text')}>
    <Icon icon={statusGlyph[status]} size={12} weight="bold"/>{statusLabel ?? statusWords[status]}
  </span> : null;
  if (indeterminate) return <span data-slot="progress-value" className={cls}><Icon icon={Pending} size={12} className="motion-safe:hidden"/></span>;
  if (mode === 'meter') return <span className={cls}>
    {words}<MeterPrimitive.Value data-slot="progress-value" {...props}>{children ?? undefined}</MeterPrimitive.Value>
  </span>;
  return (
    <span className={cls}>
      {words}<ProgressPrimitive.Value data-slot="progress-value" {...(props)}>
        {children ? (formatted, value) => children(formatted ?? '', value ?? 0) : undefined}
      </ProgressPrimitive.Value>
    </span>
  );
}

export { Progress, ProgressLabel, ProgressValue, meterStatus };
