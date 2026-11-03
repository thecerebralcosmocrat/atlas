import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import { cva } from 'class-variance-authority';
import {Icon, CollapseAll, Stop} from '@/components/glaze/icon';
import {Button} from '@/components/glaze/ui/button';
import {Status, statusLabels} from '@/components/glaze/ui/status';
import {cn} from '@/lib/glaze/utils';

// One turn in a conversation, plus the dividers between turns.
//
// Two layouts, one thread column, both 16px in from the edge.
// - The agent's turn is message flow at the full width, with no box and no fill: optional reasoning, tool rows
//   (ToolCallList), the answer in prose (Response), and a footer with its actions and the model that answered
//   (MessageModel). The order is fixed and every section is optional. AgentTurn reads the name, state and time aloud and
//   draws them only for a turn that failed or stopped, where the word matters. The live state is the running tool row,
//   so the header says nothing about it.
// - The person's turn is a bubble at the end of the row: the shell's grey on the 10px corner of a box of text, a 1px
//   faint edge, up to 85% of the width. It is not pressed, so it is flat: no glass. Their name and the time are in the
//   header for screen readers and not drawn. A message that did not send keeps its text, its edge turns coral the way
//   an invalid field's line does, and "Not sent" with Retry sits under it (MessageSendState).
// - MessageModel names the model that answered in mono at 0.8 in the footer, so a turn answered by a fallback says so.
// - MessageDivider marks a point in the thread: a caption anchored at the start, then a faint hairline to the end. A
//   handoff to a person is the one centred thing in a thread, the waiting mark and its words between two lines, because
//   from then until they reply the thread waits on them.
// No state of its own.

const messageVariants = cva('group/message relative flex w-full min-w-0 px-4 py-2', {
  variants: {
    size: {
      default: 'type-body',
      sm: 'type-body-sm',
    },
  },
  defaultVariants: {size: 'default'},
});

function MessageGroup({
  className,
  ...props
}) {
  return <div data-slot="message-group" className={cn('flex min-w-0 flex-col gap-4', className)} {...props}/>;
}

function Message({
  className,
  from = 'agent',
  size = 'default',
  ...props
}) {
  return <div
    data-slot="message"
    data-from={from}
    data-size={size}
    className={cn(messageVariants({size}), from === 'user' && 'justify-end', className)}
    {...props}
  />;
}

/**
 * A whole agent turn in one piece: the sections, with the header (name, state, time) read aloud and not drawn, the way
 * a person's is. A turn that failed or stopped draws the header so its word shows.
 */
function AgentTurn({
  name,
  time,
  state = 'done',
  children,
  ...props
}) {
  return <Message from="agent" {...props}>
    <MessageContent>
      <MessageHeader className={state === 'fail' || state === 'stopped' ? undefined : 'sr-only'}>{name}<MessageStatus state={state}/>{time && <MessageTime>{time}</MessageTime>}</MessageHeader>
      {children}
    </MessageContent>
  </Message>;
}

/** Turns of the same speaker. The person's is a column at the end; the agent's sections sit 8px apart. */
function MessageContent({
  className,
  ...props
}) {
  return <div
    data-slot="message-content"
    className={cn(
      'flex min-w-0 flex-1 flex-col break-words text-text-1',
      'group-data-[from=user]/message:max-w-[85%] group-data-[from=user]/message:flex-none group-data-[from=user]/message:items-end group-data-[from=user]/message:gap-1',
      'group-data-[from=user]/message:*:data-[slot=message-header]:sr-only',
      'group-data-[from=agent]/message:gap-2',
      className,
    )}
    {...props}
  />;
}

/** The speaker's name, then MessageStatus and MessageTime at the end: one quiet caption line above the content. */
function MessageHeader({
  className,
  ...props
}) {
  return <div
    data-slot="message-header"
    className={cn('flex min-h-(--control-sm) min-w-0 shrink-0 items-center gap-2 type-label-sm text-text-1', className)}
    {...props}
  />;
}

/** A quiet value beside the name or in the footer: a count, a summary. */
function MessageMeta({
  className,
  ...props
}) {
  return <span data-slot="message-meta" className={cn('min-w-0 truncate type-caption text-text-2 data', className)} {...props}/>;
}

/** The turn's time, in a fixed end column, so times line up down the thread. */
function MessageTime({
  className,
  ...props
}) {
  return <time
    data-slot="message-time"
    className={cn('ms-auto w-12 shrink-0 truncate text-end type-caption text-text-2 data [[data-slot=message-status]~&]:ms-0', className)}
    {...props}
  />;
}

/**
 * The model that answered this turn, in mono at 0.8 for the footer. When it is not the model the person picked (a
 * fallback after a rate limit), pass `requested`: "for glaze-large" follows it.
 */
function MessageModel({
  model,
  requested,
  forModel = name => `for ${name}`,
  className,
  ...props
}) {
  const switched = requested !== undefined && requested !== model;
  return <span data-slot="message-model" data-switched={switched || undefined} className={cn('inline-flex min-w-0 items-baseline gap-1.5 type-caption text-text-2', className)} title={switched ? `${model} ${forModel(requested)}` : model} {...props}>
    <span className="mono min-w-0 truncate">{model}</span>
    {switched && <span className="min-w-0 truncate">{forModel(requested)}</span>}
  </span>;
}

const statusWords = {working: statusLabels.running, paused: statusLabels.waiting, failed: statusLabels.fail, stopped: 'Stopped'};

/**
 * The agent turn's state, in its MessageHeader. One per turn: the footer reads it, so the state lives in one place.
 * Live, waiting and done show nothing (the running tool row, or the approval card, is the live thing) and are read
 * aloud; a failed turn shows a coral "Failed" and a stopped one a plain "Stopped" at the end of the line.
 */
function MessageStatus({
  state,
  label,
  labels,
  className,
  ...props
}) {
  const words = {...statusWords, ...labels};
  const content = state === 'fail' ? <Status status="fail" size="sm">{label ?? words.failed}</Status>
    : state === 'stopped' ? <span>{label ?? words.stopped}</span>
      : state === 'live' ? <span className="sr-only">{label ?? words.working}</span>
        : state === 'waiting' ? <span className="sr-only">{label ?? words.paused}</span>
          : label ? <span className="sr-only">{label}</span> : null;
  return <span
    data-slot="message-status"
    data-state={state}
    className={cn('ms-auto inline-flex shrink-0 items-center justify-end type-caption whitespace-nowrap text-text-2', className)}
    {...props}
  >{content}</span>;
}

/**
 * The agent turn's last section, under a finished turn: a quiet line ("Worked for 14s, 14:02", MessageWorked), copy
 * and retry as ghost icon-sm Buttons that show on hover or focus where there is a pointer, and at the end the model that
 * answered (MessageModel) and a summary (MessageMeta). Hidden while the turn is live or waiting. On touch the buttons
 * always show, since there is no hover to reveal them.
 */
function MessageFooter({
  className,
  ...props
}) {
  return <div
    data-slot="message-footer"
    className={cn(
      'flex min-h-(--control) max-w-full min-w-0 shrink-0 items-center gap-0.5 type-caption text-text-2',
      '-ms-2 *:data-[slot=message-model]:ms-auto *:data-[slot=message-meta]:ms-auto [&>[data-slot=message-model]+[data-slot=message-meta]]:ms-3',
      // The buttons wait for a pointer to arrive on the turn or a key to land in the footer; a keyboard user is never left without them.
      // Buttons and CopyButton (data-slot ending in button) fade in on the turn's hover, or when a key lands in the footer.
      '[&>[data-slot$=button]]:transition-opacity [&>[data-slot$=button]]:duration-(--dur-state)',
      'pointer-fine:group-data-[from=agent]/message:[&>[data-slot$=button]]:opacity-0',
      'pointer-fine:group-data-[from=agent]/message:group-hover/message:[&>[data-slot$=button]]:opacity-100',
      'pointer-fine:group-data-[from=agent]/message:has-[:focus-visible,[data-force-focus-visible]]:[&>[data-slot$=button]]:opacity-100',
      'group-has-[[data-slot=message-status]:is([data-state=live],[data-state=waiting])]/message:hidden',
      className,
    )}
    {...props}
  />;
}

const workedLabels = {worked: duration => `Worked for ${duration}`};

/**
 * The footer's first words: how long the turn worked and when it ended, "Worked for 14s, 14:02". Pass `duration`
 * already formatted (formatDuration from tool-call); with only a `time` it reads the time alone. It sits on the text
 * column, since the buttons after it carry their own inset.
 */
function MessageWorked({
  duration,
  time,
  labels,
  className,
  ...props
}) {
  const words = {...workedLabels, ...labels};
  return <span data-slot="message-worked" className={cn('ms-2 me-1 inline-flex min-w-0 items-baseline gap-1.5 truncate type-caption text-text-2 data', className)} {...props}>
    {duration && <span className="min-w-0 truncate">{words.worked(duration)}{time && ','}</span>}
    {time && <span className="shrink-0">{time}</span>}
  </span>;
}

// ---------- Bubble ----------

// The person's words.
//   default  the shell's grey with a faint edge, on the 10px corner of a box of text
//   outline  paper with the control line, for a quoted or edited draft
// status="fail" turns the edge coral, for a message that did not send.
const bubbleVariants = cva(
  ['group/bubble relative flex w-auto max-w-(--measure) min-w-0 flex-col gap-1 self-end'],
  {
    variants: {
      variant: {
        default: '*:data-[slot=message-bubble-content]:border-line-faint *:data-[slot=message-bubble-content]:bg-shell',
        outline: '*:data-[slot=message-bubble-content]:border-line-control *:data-[slot=message-bubble-content]:bg-paper',
      },
    },
    defaultVariants: {variant: 'default'},
  },
);

function MessageBubble({
  variant = 'default',
  status,
  className,
  ...props
}) {
  return <div
    data-slot="message-bubble"
    data-variant={variant}
    data-status={status}
    className={cn(bubbleVariants({variant}), status === 'fail' && '*:data-[slot=message-bubble-content]:border-fail', className)}
    {...props}
  />;
}

function MessageBubbleContent({
  className,
  render,
  ...props
}) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps({
      className: cn(
        'w-fit max-w-full min-w-0 self-end rounded-overlay border px-3 py-2 type-body break-words whitespace-pre-wrap text-text-1 [overflow-wrap:anywhere]',
        'forced-colors:border-[CanvasText]',
        // A bubble that is a button or a link (reopen a draft) takes the wash under the pointer.
        '[&:is(button,a)]:text-start [&:is(button,a)]:transition-colors [&:is(button,a)]:duration-(--dur-state) [&:is(button,a)]:hover:bg-hover',
        className,
      ),
    }, props),
    render,
    state: {slot: 'message-bubble-content'},
  });
}

/** A 20px strip under the text for reactions or a read receipt: each one a small tag with the control line. */
function MessageReactions({
  className,
  ...props
}) {
  return <div
    data-slot="message-reactions"
    dir="auto"
    className={cn('flex min-h-5 w-fit flex-wrap items-center gap-1 type-label-sm text-text-1 data *:inline-flex *:h-5 *:items-center *:gap-1 *:rounded-tag *:border *:border-line-control *:px-1.5', className)}
    {...props}
  />;
}

const sendStateLabels = {sending: 'Sending', notSent: 'Not sent', retry: 'Retry'};

/**
 * Whether the person's message reached the agent. Sending shows quiet text; failed keeps the text, says so in coral and
 * offers Retry on the same line, so nothing the person wrote is lost.
 */
function MessageSendState({
  state,
  onRetry,
  labels,
  className,
  ...props
}) {
  const words = {...sendStateLabels, ...labels};
  if (state === 'sent') return null;
  return <div
    data-slot="message-send-state"
    data-state={state}
    className={cn('flex min-h-(--control-sm) items-center gap-2 type-caption text-text-2', className)}
    {...props}
  >
    <span role="status">{state === 'sending' ? words.sending : <Status status="fail" size="sm">{words.notSent}</Status>}</span>
    {state === 'failed' && onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{words.retry}</Button>}
  </div>;
}

// ---------- Divider ----------

const dividerVariants = cva(
  'group/divider relative flex min-h-(--control-sm) w-full items-center gap-2 px-4 text-start type-caption text-text-2 [&_a]:text-text-1 [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4',
  {
    variants: {
      variant: {
        // Words only, for a label that needs no line.
        default: '',
        // The quiet form: the words at the start, then a faint hairline to the end.
        separator: 'after:h-px after:min-w-4 after:flex-1 after:bg-line-faint',
        // A handoff to a person: the waiting mark and its words between two lines, the one centred thing in a thread.
        handoff: 'justify-center before:h-px before:min-w-4 before:flex-1 before:bg-line after:h-px after:min-w-4 after:flex-1 after:bg-line forced-colors:before:bg-[CanvasText] forced-colors:after:bg-[CanvasText]',
      },
    },
    defaultVariants: {variant: 'default'},
  },
);

const reasonLabel = {compaction: 'Context compacted', interrupted: 'Interrupted', handoff: statusLabels.waiting};
const reasonIcon = {
  compaction: CollapseAll,
  interrupted: Stop
};

function MessageDivider({
  className,
  variant,
  reason,
  to = 'person',
  labels,
  render,
  children,
  ...props
}) {
  const reasonText = reason ? (labels?.[reason] ?? (reason === 'handoff' && to === 'agent' ? undefined : reasonLabel[reason])) : undefined;
  const toPerson = reason === 'handoff' && to === 'person';
  const v = variant ?? (toPerson ? 'handoff' : reason ? 'separator' : 'default');
  const glyph = reason === 'compaction' || reason === 'interrupted' ? reasonIcon[reason] : undefined;
  const text = children ?? reasonText ?? null;
  return useRender({
    defaultTagName: 'div',
    props: mergeProps({
      role: 'separator',
      className: cn(dividerVariants({variant: v}), className),
      children: v === 'handoff'
        ? <Status data-slot="message-divider-content" status="waiting" size="sm" className="min-w-0 shrink">{text}</Status>
        : <>
            {glyph && <span data-slot="message-divider-icon" aria-hidden className="flex size-4 shrink-0 items-center justify-center text-text-3"><Icon icon={glyph} size={12}/></span>}
            <span data-slot="message-divider-content" className="min-w-0 shrink break-words">{text}</span>
          </>,
    }, {
      'data-reason': reason,
      'data-variant': v,
      'aria-label': typeof children === 'string' ? children : reasonText
    }, props),
    render,
    state: {slot: 'message-divider', variant: v},
  });
}

export { MessageGroup, Message, AgentTurn, MessageContent, MessageHeader, MessageMeta, MessageTime, MessageModel, MessageStatus, MessageFooter, MessageWorked, MessageBubble, MessageBubbleContent, MessageReactions, MessageSendState, MessageDivider, messageVariants, bubbleVariants, dividerVariants };
