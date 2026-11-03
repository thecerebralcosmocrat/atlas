'use client';;
import {useEffect, useRef, useState} from 'react';
import {Badge} from '@/components/glaze/ui/badge';
import {ActivityArc, formatCount, formatElapsed} from '@/components/glaze/ai/activity';
import {cn} from '@/lib/glaze/utils';

const tickerLabels = {
  showMore: n => `Show ${formatCount(n)} more`,
  showLess: 'Show less',
  requests: 'Requests',
};

/** The class of a status code: ok for 1xx to 3xx, warn for 4xx, fail for 5xx and anything unreadable. */
function codeClass(code) {
  if (code === undefined || code === '') return undefined;
  const n = Number(code);
  if (!Number.isFinite(n)) return 'fail';
  return n >= 500 ? 'fail' : n >= 400 ? 'warn' : 'ok';
}

/** How many requests there are and how many failed. A 4xx and a 5xx both count as failed. */
function countRequests(items) {
  const failed = items.filter(r => codeClass(r.code) === 'warn' || codeClass(r.code) === 'fail').length;
  return {head: `${formatCount(items.length)} ${items.length === 1 ? 'request' : 'requests'}`, failed};
}

/** "42 requests, 2 failed": the detail of a finished call, as text. */
function summarizeRequests(items) {
  const {head, failed} = countRequests(items);
  return failed ? `${head}, ${failed} failed` : head;
}

/** The same summary for a row, with the failed count in the failure word colour so it reads as trouble. */
function RequestSummary({
  items
}) {
  const {head, failed} = countRequests(items);
  return failed ? <>{head}, <span data-slot="request-ticker-failed" className="text-fail-text">{failed} failed</span></> : head;
}

/** The newest `max` items, held for at least `hold` ms per set while live, so a burst never blurs. */
function useHeldWindow(items, max, live, hold) {
  const [shown, setShown] = useState(() => items.slice(-max));
  const at = useRef(0);
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    const next = () => { at.current = Date.now(); setShown(latest.current.slice(-max)); };
    if (!live) { next(); return; }
    const wait = Math.max(0, hold - (Date.now() - at.current));
    if (!wait) { next(); return; }
    const timer = setTimeout(next, wait);
    return () => clearTimeout(timer);
  }, [items, max, live, hold]);
  return shown;
}

const codeBadge = {
  ok: 'outline',
  warn: 'warn',
  fail: 'fail'
};

function Row({
  request,
  live,
  as: As = 'div'
}) {
  const status = codeClass(request.code);
  return <As
    data-slot="request-ticker-row"
    data-status={status === 'warn' || status === 'fail' ? status : undefined}
    className="flex h-(--menu-row-sm) min-w-0 items-center gap-3"
  >
    <span className="flex w-16 shrink-0">{request.method && <Badge variant="outline" size="sm"><span className="mono">{request.method}</span></Badge>}</span>
    <span dir="ltr" className="min-w-0 flex-1 truncate text-start type-code-xs text-text-1">{request.target}</span>
    <span className="flex w-10 shrink-0 justify-end">{status ? <Badge variant={codeBadge[status]} size="sm"><span className="mono">{request.code}</span></Badge> : live && <ActivityArc className="text-text-2"/>}</span>
    <span className="w-14 shrink-0 text-end type-caption text-text-2 data">{request.duration !== undefined && formatElapsed(request.duration)}</span>
  </As>;
}

/** The well's last row: a full-width 28px button that runs to the well's edges (12px, 8px below), under a hairline. */
function ShowMoreRow({
  className,
  ...props
}) {
  return <button
    type="button"
    className={cn('-mx-3 -mb-2 mt-1 flex h-(--menu-row-sm) items-center self-stretch border-t border-line-faint px-3 text-start type-label-sm text-text-2 transition-colors duration-(--dur-state) ease-out hover:bg-hover hover:text-text-1 focus-visible:focus-ring-inset', className)}
    {...props}
  />;
}

function RequestTicker({
  items,
  live = false,
  max = 3,
  cap = 10,
  hold = 300,
  labels,
  className,
  ...props
}) {
  const words = {...tickerLabels, ...labels};
  const recent = useHeldWindow(items, max, live, hold);
  const [all, setAll] = useState(false);
  if (live) {
    return <div data-slot="request-ticker" data-live="" aria-hidden className={cn('flex min-w-0 flex-col', className)} {...props}>
      {recent.map(r => <Row key={r.id} request={r} live/>)}
    </div>;
  }
  const hidden = all ? 0 : Math.max(0, items.length - cap);
  const shown = hidden ? items.slice(0, cap) : items;
  return <div data-slot="request-ticker" className={cn('flex min-w-0 flex-col', className)} {...props}>
    <ol aria-label={words.requests} className="flex min-w-0 flex-col">
      {shown.map(r => <Row key={r.id} as="li" request={r} live={false}/>)}
    </ol>
    {items.length > cap && <ShowMoreRow data-slot="request-ticker-more" onClick={() => setAll(v => !v)}>{all ? words.showLess : words.showMore(hidden)}</ShowMoreRow>}
  </div>;
}

export { RequestTicker, RequestSummary, ShowMoreRow, summarizeRequests, codeClass };
