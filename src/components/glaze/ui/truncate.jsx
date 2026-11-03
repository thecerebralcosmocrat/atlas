'use client';;
import {Tooltip} from '@base-ui/react/tooltip';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useGlazePortal} from '@/lib/glaze/portal';
import {cn, mergeRefs} from '@/lib/glaze/utils';
import {tooltipMotionClass, tooltipPopupClass} from '@/components/glaze/ui/tooltip';

/** The hint's classes: Tooltip's chip and its motion, so a hint and a tooltip are one look. */
const textHintClass = cn(tooltipPopupClass, '[overflow-wrap:anywhere]');

function TextHint({
  content,
  children,
  disabled,
  side = 'top'
}) {
  const container = useGlazePortal();
  const [open, setOpen] = useState(false);
  const pointer = useRef('');
  const pinned = useRef(false);
  const coarse = () => pointer.current === 'touch' || pointer.current === 'pen';

  const onOpenChange = (next, details) => {
    // A tap focuses the element before its click lands; the click decides, not the focus.
    if (coarse() && details.reason !== 'escape-key' && details.reason !== 'outside-press') return;
    // A pinned hint ignores hover and focus changes; only a tap or Escape closes it.
    if (pinned.current && !next && details.reason !== 'escape-key' && details.reason !== 'outside-press') return;
    if (!next) pinned.current = false;
    setOpen(next);
  };

  return (
    <Tooltip.Root disabled={disabled} open={open && !disabled} onOpenChange={onOpenChange}>
      <Tooltip.Trigger
        delay={400}
        render={children}
        onPointerDown={(event) => { pointer.current = event.pointerType; }}
        onKeyDown={() => { pointer.current = ''; }}
        onClickCapture={(event) => {
          if (!coarse()) return;
          pointer.current = '';
          if (disabled) return;
          event.preventDefault();
          event.stopPropagation();
          pinned.current = !open;
          setOpen(!open);
        }}
      />
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={8} className="isolate z-(--z-overlay)">
          <Tooltip.Popup data-slot="text-hint" className={cn(textHintClass, tooltipMotionClass)}><span className="min-w-0">{content}</span></Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;

/** Where each character a person sees starts, in UTF-16 offsets: an emoji or a letter with its accent is one. */
function characterStarts(text) {
  if (graphemes) return Array.from(graphemes.segment(text), s => s.index);
  const starts = [];
  let at = 0;
  for (const point of text) { starts.push(at); at += point.length; }
  return starts;
}

/**
 * Where to split a middle cut, as a UTF-16 offset for slice(). Paths keep their last segment; anything else keeps its
 * last `tail` characters, counted as a person sees them, so a cut never lands inside an emoji.
 */
function splitTail(text, tail) {
  const starts = characterStarts(text);
  if (tail === 'auto') {
    const slash = text.lastIndexOf('/');
    if (slash > 0 && slash < text.length - 1 && starts.length - starts.indexOf(slash) <= 32) return slash;
    tail = 6;
  }
  tail = Math.floor(tail);
  if (!(tail > 0)) return text.length;
  return starts.length <= tail ? 0 : starts[starts.length - tail];
}

/** True while the element's content is wider than its box. */
function useClipped(ref, text) {
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, text]);
  return clipped;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The middle cut. The head stays whole in the DOM; the cut clips the head to a whole number of characters (measured
 * with a Range, so kerning counts) and puts its own ellipsis between head and tail, so the ellipsis always touches the
 * tail. A copy takes the full string.
 */
function MiddleTruncate({
  children,
  tail,
  hint,
  focusable,
  className,
  ...props
}) {
  const outer = useRef(null);
  const head = useRef(null);
  const tailEl = useRef(null);
  const dots = useRef(null);
  const [clipped, setClipped] = useState(false);
  const at = splitTail(children, tail);
  const headText = children.slice(0, at);
  const tailText = children.slice(at);

  useLayoutEffect(() => {
    const box = outer.current;
    const h = head.current;
    const t = tailEl.current;
    const d = dots.current;
    const node = h?.firstChild;
    if (!box || !h || !t || !d || !node) return;
    const span = (n) => {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, n);
      return range.getBoundingClientRect().width;
    };
    const ends = [...characterStarts(headText).slice(1), headText.length];
    const measure = () => {
      h.style.width = '';
      d.style.display = 'none';
      const avail = box.clientWidth;
      const full = span(headText.length) + t.getBoundingClientRect().width;
      if (full <= avail + 0.5 || headText.length === 0) { setClipped(false); return; }
      d.style.display = 'inline';
      const room = avail - d.getBoundingClientRect().width - t.getBoundingClientRect().width;
      let lo = -1;
      let hi = ends.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (span(ends[mid]) <= room) lo = mid; else hi = mid - 1;
      }
      h.style.width = `${lo < 0 ? 0 : span(ends[lo])}px`;
      setClipped(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [headText, tailText]);

  const onCopy = (event) => {
    const selected = window.getSelection()?.toString() ?? '';
    if (!selected) return;
    const joined = new RegExp(`${escapeRe(headText)}\\s*${escapeRe(tailText)}`);
    event.clipboardData.setData('text/plain', joined.test(selected) ? selected.replace(joined, children) : children);
    event.preventDefault();
  };

  const tab = clipped && hint && focusable ? 0 : undefined;
  const text = <span ref={outer} className="block max-w-full min-w-0">
    <span
      data-slot="truncate"
      data-position="middle"
      data-clipped={clipped || undefined}
      dir="auto"
      tabIndex={tab}
      onCopy={onCopy}
      className={cn('inline-flex max-w-full whitespace-nowrap focus-visible:rounded-tag', className)}
      {...props}
    >
      <span ref={head} data-slot="truncate-head" className="overflow-hidden">{headText}</span>
      <span ref={dots} data-slot="truncate-ellipsis" aria-hidden="true" className="hidden shrink-0 select-none">…</span>
      <span ref={tailEl} data-slot="truncate-tail" className="shrink-0">{tailText}</span>
    </span>
  </span>;
  if (!hint) return text;
  return <TextHint content={children} disabled={!clipped}>{text}</TextHint>;
}

function Truncate({
  children,
  position = 'end',
  tail = 'auto',
  hint = true,
  focusable = true,
  className,
  ref,
  ...props
}) {
  const cut = useRef(null);
  const cutRefs = useMemo(() => mergeRefs(cut, ref), [ref]);
  const clipped = useClipped(cut, children);
  if (position === 'middle') return <MiddleTruncate tail={tail} hint={hint} focusable={focusable} className={className} ref={ref} {...props}>{children}</MiddleTruncate>;
  const tab = clipped && hint && focusable ? 0 : undefined;
  const text = <span
    ref={cutRefs}
    data-slot="truncate"
    data-position="end"
    data-clipped={clipped || undefined}
    tabIndex={tab}
    className={cn('block min-w-0 truncate focus-visible:rounded-tag', className)}
    {...props}
  >{children}</span>;
  if (!hint) return text;
  return <TextHint content={children} disabled={!clipped}>{text}</TextHint>;
}

export { Truncate, TextHint, textHintClass, splitTail };
