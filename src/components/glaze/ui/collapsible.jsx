'use client';;
import { createContext, useContext } from 'react';
import {Collapsible as CollapsiblePrimitive} from '@base-ui/react/collapsible';
import {Accordion as AccordionPrimitive} from '@base-ui/react/accordion';
import {cn} from '@/lib/glaze/utils';
import {Icon, ChevronRight} from '@/components/glaze/icon';

const GroupContext = createContext(null);

function Collapsible({
  className,
  value,
  ...props
}) {
  const group = useContext(GroupContext);
  if (group) return (
    <AccordionPrimitive.Item
      data-slot="collapsible"
      value={value}
      className={cn('rule-row', className)}
      {...(props)}
    />
  );
  return <CollapsiblePrimitive.Root data-slot="collapsible" className={cn('flex flex-col', className)} {...props}/>;
}

/** A stack of Collapsibles; one open at a time unless multiple. */
function CollapsibleGroup({
  className,
  variant = 'framed',
  multiple = false,
  ...props
}) {
  return (
    <GroupContext.Provider value={{variant}}>
      <AccordionPrimitive.Root
        data-slot="collapsible-group"
        data-variant={variant}
        multiple={multiple}
        className={cn('group/collapsible-group flex w-full flex-col', variant === 'framed' && 'overflow-hidden rounded-overlay border border-line-faint bg-paper', className)}
        {...props}
      />
    </GroupContext.Provider>
  );
}

/** The summary, right after the label. A status sets it in that status's word colour. */
function Summary({
  children,
  status
}) {
  return <span
    data-slot="collapsible-summary"
    data-status={status}
    className={cn('min-w-0 truncate type-caption group-data-panel-open/collapsible-trigger:hidden', status === 'fail' ? 'text-fail-text' : status === 'warn' ? 'text-warn-text' : 'text-text-2')}
  >{children}</span>;
}

function CollapsibleTrigger({
  className,
  children,
  caret = true,
  size = 'default',
  summary,
  summaryStatus,
  ...props
}) {
  const group = useContext(GroupContext);
  if (group) return (
    <AccordionPrimitive.Header data-slot="collapsible-header" className="flex">
      <AccordionPrimitive.Trigger
        data-slot="collapsible-trigger"
        className={cn(
          'group/collapsible-trigger flex min-h-(--row) flex-1 items-center gap-2 px-3 py-2 text-start type-label text-text-1',
          'hover:not-data-disabled:bg-hover data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
          'focus-visible:focus-ring-inset',
          'group-data-[variant=plain]/collapsible-group:px-0 group-data-[variant=plain]/collapsible-group:hover:not-data-disabled:bg-transparent',
          className,
        )}
        {...(props)}
      >
        {caret && <CollapsibleCaret/>}
        {/* Label and summary share one wrapping row, so a summary that does not fit drops under the label. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0">{children}</span>
          {summary && <Summary status={summaryStatus}>{summary}</Summary>}
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      data-size={size}
      className={cn(
        'group/collapsible-trigger inline-flex w-max max-w-full items-center gap-2 self-start rounded-pill text-start text-text-1',
        'hover:not-data-disabled:bg-hover active:not-data-disabled:bg-pressed data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
        size === 'sm' ? 'min-h-(--control-sm) ps-2 pe-2.5 type-label-sm' : 'min-h-(--control) ps-2.5 pe-3 type-label',
        className,
      )}
      {...props}
    >
      {caret && <CollapsibleCaret/>}
      <span className="min-w-0 truncate">{children}</span>
      {summary && <Summary status={summaryStatus}>{summary}</Summary>}
    </CollapsiblePrimitive.Trigger>
  );
}

/** The caret that turns a quarter when its trigger's region is open. Points to the end in right to left. */
function CollapsibleCaret({
  className
}) {
  return <Icon
    icon={ChevronRight}
    size={12}
    data-slot="collapsible-caret"
    className={cn('shrink-0 text-text-3 transition-[rotate] duration-(--dur-state) ease-out rtl:-scale-x-100 group-data-panel-open/collapsible-trigger:rotate-90 rtl:group-data-panel-open/collapsible-trigger:-rotate-90', className)}
  />;
}

// The height cuts, since moving it reflows the page under it; the content fades in over --dur-state and goes at once.
const panelMotion = 'overflow-hidden transition-opacity duration-(--dur-state) ease-out data-starting-style:opacity-0';

/**
 * The region. className styles the box that holds the content: inside a group it is the padded text under the
 * label, lined up with it; standalone it is the panel itself, which has no padding of its own. Group panels stay in
 * the DOM as hidden="until-found", so find-in-page reaches a closed section and opens it.
 */
function CollapsibleContent({
  className,
  children,
  ...props
}) {
  const group = useContext(GroupContext);
  if (group) return (
    <AccordionPrimitive.Panel
      hiddenUntilFound
      data-slot="collapsible-content"
      className={panelMotion}
      {...(props)}
    >
      <div className={cn(
        'max-w-(--measure) ps-8 pe-3 pb-3 type-body-sm text-text-2 group-data-[variant=plain]/collapsible-group:ps-5',
        '[&_a]:text-text-1 [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4 [&_p:not(:last-child)]:mb-2',
        className,
      )}>{children}</div>
    </AccordionPrimitive.Panel>
  );
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(panelMotion, className)}
      {...props}
    >{children}</CollapsiblePrimitive.Panel>
  );
}

export { Collapsible, CollapsibleGroup, CollapsibleTrigger, CollapsibleCaret, CollapsibleContent };
