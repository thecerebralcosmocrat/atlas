'use client';;
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {cva} from 'class-variance-authority';
import { Icon, Close, Failed, Information, Success, Warning } from '@/components/glaze/icon';
import {Button} from '@/components/glaze/ui/button';
import {cn, mergeRefs} from '@/lib/glaze/utils';

// Four silhouettes that differ without colour: a circle with i, a circle with a check, a triangle, a circle with !.
const statusIcon = {neutral: Information, ok: Success, warn: Warning, fail: Failed};

const alertVariants = cva('group/alert @container/alert relative w-full min-w-0 rounded-overlay p-3 text-start text-text-1 forced-colors:border forced-colors:border-[CanvasText]', {
  variants: {
    status: {
      neutral: 'border border-line bg-paper',
      ok: 'bg-ok-tint',
      warn: 'bg-warn-tint',
      fail: 'bg-fail-tint',
    },
  },
  defaultVariants: {status: 'neutral'},
});

const AlertContext = createContext(null);

const storageKey = (key) => `glaze:alert-dismissed:${key}`;
function readDismissed(key) {
  try { return localStorage.getItem(storageKey(key)) === '1'; } catch { return false; }
}

/** The next element after `from` in document order that takes focus, outside `from` itself. */
function nextFocusable(from) {
  const all = [...document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  )];
  return all.find(el => !from.contains(el) && (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
}

function Alert({
  className,
  status = 'neutral',
  icon = true,
  announce = true,
  dismissKey,
  onDismiss,
  role,
  children,
  ref,
  ...props
}) {
  const root = useRef(null);
  const rootRefs = useMemo(() => mergeRefs(root, ref), [ref]);
  // Undefined until the stored dismissal is read, so an alert dismissed before never flashes in.
  const [dismissed, setDismissed] = useState(dismissKey ? undefined : false);
  useLayoutEffect(() => { if (dismissKey) setDismissed(readDismissed(dismissKey)); }, [dismissKey]);

  const dismissible = status === 'neutral' || status === 'ok';
  const dismiss = useCallback(() => {
    if (!dismissible) return;
    const next = root.current ? nextFocusable(root.current) : null;
    if (dismissKey) { try { localStorage.setItem(storageKey(dismissKey), '1'); } catch {} }
    setDismissed(true);
    onDismiss?.();
    requestAnimationFrame(() => next?.focus());
  }, [dismissible, dismissKey, onDismiss]);

  if (dismissed !== false) return null;
  if (children === undefined || children === null || children === false) return null;

  const glyph = icon === false || icon === null ? null : icon === true ? <Icon icon={statusIcon[status]} size={14}/> : icon;
  const loud = status === 'warn' || status === 'fail';

  return <AlertContext.Provider value={{status, dismiss, dismissible}}>
    <div
      ref={rootRefs}
      data-slot="alert"
      data-status={status}
      role={role ?? (announce ? (loud ? 'alert' : 'status') : undefined)}
      className={cn(alertVariants({status}), className)}
      {...props}
    >
      {/* Parts place themselves on named areas, so they work in any order. Under 24rem the action drops under the text. */}
      <div
        data-slot="alert-grid"
        className={cn(
          'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-start [grid-template-areas:"icon_title_action_close""icon_desc_action_close""icon_more_more_more"]',
        )}
      >
        {glyph && <span data-slot="alert-icon" className={cn(
          'me-2 flex h-lh items-center type-label [grid-area:icon] group-not-has-data-[slot=alert-title]/alert:type-body-sm',
          status === 'neutral' ? 'text-text-2' : status === 'ok' ? 'text-ok-text' : status === 'warn' ? 'text-warn-text' : 'text-fail-text',
        )}>{glyph}</span>}
        {children}
      </div>
    </div>
  </AlertContext.Provider>;
}

function useAlert() {
  const context = useContext(AlertContext);
  if (!context) throw new Error('Alert parts must be inside <Alert>.');
  return context;
}

/** The headline: names the thing in words ("Key expires tomorrow"). */
function AlertTitle({
  className,
  ...props
}) {
  return <p data-slot="alert-title" className={cn('min-w-0 type-label text-text-1 [overflow-wrap:anywhere] [grid-area:title]', className)} {...props}/>;
}

/** What happened and what to do now. Links inside are ink and underlined. */
function AlertDescription({
  className,
  ...props
}) {
  return <div
    data-slot="alert-description"
    className={cn(
      'min-w-0 type-body-sm text-text-1 [overflow-wrap:anywhere] [grid-area:desc] group-data-[status=neutral]/alert:text-text-2',
      '[&_a]:text-text-1 [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-2',
      className,
    )}
    {...props}
  />;
}

/** One or two size="sm" Buttons at the end of the row; under the message when the alert is under 24rem wide. */
function AlertAction({
  className,
  ...props
}) {
  return <div
    data-slot="alert-action"
    className={cn(
      'ms-3 -my-0.5 flex max-w-full min-w-0 flex-wrap items-center gap-2 self-center [grid-area:action]',
      '@max-sm/alert:ms-0 @max-sm/alert:mt-2 @max-sm/alert:my-0 @max-sm/alert:justify-self-start @max-sm/alert:[grid-area:more]',
      className,
    )}
    {...props}
  />;
}

/** Dismisses a neutral or ok alert. Renders nothing on warn and fail, which stay until the problem is fixed. */
function AlertClose({
  className,
  label = 'Dismiss',
  onClick,
  ...props
}) {
  const {dismiss, dismissible} = useAlert();
  if (!dismissible) {
    if (process.env.NODE_ENV !== 'production') console.warn('AlertClose: warn and fail alerts stay until the problem is fixed, so the close button is not rendered.');
    return null;
  }
  return <Button
    variant="ghost"
    size="icon-sm"
    data-slot="alert-close"
    aria-label={label}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) dismiss(); }}
    className={cn('ms-2 -me-1.5 -mt-1 self-start [grid-area:close]', className)}
    {...props}
  >
    <Icon icon={Close} size={12}/>
  </Button>;
}

export { Alert, AlertTitle, AlertDescription, AlertAction, AlertClose, alertVariants };
