'use client';;
import * as React from 'react';
import {Icon, ArrowUp} from '@/components/glaze/icon';
import { Button } from '@/components/glaze/ui/button';
import {cn, mergeClass} from '@/lib/glaze/utils';

const sendLabels = {send: 'Send', stop: 'Stop', stopping: 'Stopping', sendAgain: 'Send again'};
const working = (status) => status === 'submitted' || status === 'streaming' || status === 'stopping';

function SendButton({
  status = 'ready',
  onStop,
  empty,
  blockedReason,
  generation,
  labels,
  disabled,
  onClick,
  size = 'icon-sm',
  className,
  type,
  ...props
}) {
  const words = {...sendLabels, ...labels};
  const names = {ready: words.send, submitted: words.stop, streaming: words.stop, stopping: words.stopping, error: words.sendAgain};
  const reasonId = React.useId();
  // The generation that was stopped. A press for the same generation is dropped.
  const stopped = React.useRef(null);
  const [stopPressed, setStopPressed] = React.useState(false);
  React.useEffect(() => {
    if (!working(status)) { stopped.current = null; setStopPressed(false); }
  }, [status]);
  React.useEffect(() => { stopped.current = null; setStopPressed(false); }, [generation]);

  const isWorking = working(status);
  const shown = isWorking && stopPressed ? 'stopping' : status;
  const blocked = !isWorking && !!blockedReason;
  const nothing = !isWorking && !!empty && !blocked;
  const stop = (event) => {
    event.preventDefault();
    if (shown === 'stopping' || stopped.current === (generation ?? 'current')) return;
    stopped.current = generation ?? 'current';
    setStopPressed(true);
    onStop?.(generation);
  };
  const icon = size === 'icon-lg' ? 16 : size === 'icon' ? 14 : 12;

  return <>
    <Button
      data-slot="send-button"
      data-state={shown}
      data-empty={nothing || undefined}
      variant="primary"
      type={isWorking ? 'button' : type ?? 'submit'}
      size={size}
      disabled={isWorking ? disabled : disabled || empty || blocked}
      focusableWhenDisabled={blocked || shown === 'stopping'}
      aria-busy={shown === 'stopping' || undefined}
      aria-label={names[shown]}
      aria-describedby={blocked ? reasonId : undefined}
      aria-keyshortcuts={isWorking ? 'Escape' : 'Enter'}
      onClick={isWorking ? stop : onClick}
      className={mergeClass(shown === 'stopping' && 'cursor-progress', className)}
      {...props}
    >
      {isWorking
        ? <span aria-hidden data-slot="send-button-stop" className={cn('size-2 rounded-[1.5px] bg-current forced-colors:bg-[CanvasText]', shown === 'stopping' && 'opacity-40')}/>/* value-ok: the stop square's corner is part of the glyph's drawing, not a container radius */
        : <Icon icon={ArrowUp} size={icon}/>}
    </Button>
    {blocked && <span id={reasonId} hidden>{blockedReason}</span>}
  </>;
}

export { SendButton };
