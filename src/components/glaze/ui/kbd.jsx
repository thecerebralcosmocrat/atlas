'use client';;
import { useSyncExternalStore } from 'react';
import {cn} from '@/lib/glaze/utils';

const subscribe = () => () => {};
const detect = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other');
/** 'unknown' on the server and during hydration, until the client's platform is read. */
function usePlatform() {
  return useSyncExternalStore(subscribe, detect, () => 'unknown');
}

/** The shown and spoken forms of each named key, the Command-key platform first. Anything else is shown as typed, a single letter upper-cased. */
const names = {
  mod: {mac: '⌘', other: 'Ctrl', spoken: {mac: 'Command', other: 'Control'}},
  cmd: {mac: '⌘', other: 'Win', spoken: {mac: 'Command', other: 'Windows'}},
  ctrl: {mac: '⌃', other: 'Ctrl', spoken: {mac: 'Control', other: 'Control'}},
  shift: {mac: '⇧', other: 'Shift', spoken: {mac: 'Shift', other: 'Shift'}},
  alt: {mac: '⌥', other: 'Alt', spoken: {mac: 'Option', other: 'Alt'}},
  enter: {mac: '↵', other: 'Enter', spoken: {mac: 'Return', other: 'Enter'}},
  esc: {mac: 'Esc', other: 'Esc', spoken: {mac: 'Escape', other: 'Escape'}},
  backspace: {mac: '⌫', other: 'Backspace', spoken: {mac: 'Delete', other: 'Backspace'}},
  tab: {mac: '⇥', other: 'Tab', spoken: {mac: 'Tab', other: 'Tab'}},
  space: {mac: 'Space', other: 'Space', spoken: {mac: 'Space', other: 'Space'}},
  up: {mac: '↑', other: '↑', spoken: {mac: 'Up arrow', other: 'Up arrow'}},
  down: {mac: '↓', other: '↓', spoken: {mac: 'Down arrow', other: 'Down arrow'}},
  left: {mac: '←', other: '←', spoken: {mac: 'Left arrow', other: 'Left arrow'}},
  right: {mac: '→', other: '→', spoken: {mac: 'Right arrow', other: 'Right arrow'}},
};

/** Splits "mod+shift+p" into its keys, each with its shown and spoken form on a platform. */
function shortcut(keys, platform) {
  return keys.split('+').map(k => k.trim()).filter(Boolean).map(k => {
    const known = names[k.toLowerCase()];
    const shown = known ? known[platform] : k.length === 1 ? k.toUpperCase() : k;
    return {shown, spoken: known ? known.spoken[platform] : shown};
  });
}

const kbdClass = cn(
  // A long name wraps inside the cap, which grows taller, instead of spilling out of it.
  'pointer-events-none inline-flex min-h-5 w-fit max-w-full min-w-5 items-center justify-center gap-1 rounded-tag border border-line-control bg-paper px-1 text-center',
  'type-code-xs text-text-2 select-none [overflow-wrap:anywhere] [&_svg]:size-(--icon-sm) [&_svg]:shrink-0',
);

function Kbd({
  className,
  keys,
  children,
  ...props
}) {
  // keys="" is a shortcut with no keys: it renders nothing, not an empty cap.
  if (keys !== undefined) return <KbdShortcut keys={keys} className={className} {...props}/>;
  return <kbd data-slot="kbd" className={cn(kbdClass, className)} {...props}>{children}</kbd>;
}

function KbdShortcut({
  keys,
  className,
  ...props
}) {
  const platform = usePlatform();
  const parts = shortcut(keys, platform === 'unknown' ? 'other' : platform);
  // Until the platform is known, a key whose two forms differ is a blank cap of the minimum width.
  const neutral = platform === 'unknown' ? shortcut(keys, 'mac').map((m, i) => m.shown === parts[i].shown) : null;
  if (!parts.length) return null;
  return <kbd data-slot="kbd-group" data-platform={platform === 'unknown' ? undefined : platform} className={cn('inline-flex max-w-full flex-wrap items-center gap-1 font-[inherit]', className)} {...props}>
    {parts.map((p, i) => neutral && !neutral[i]
      ? <kbd key={i} data-slot="kbd" data-placeholder="" aria-hidden className={kbdClass}/>
      : <kbd key={i} data-slot="kbd" aria-hidden className={kbdClass}>{p.shown}</kbd>)}
    {platform !== 'unknown' && <span className="sr-only">{parts.map(p => p.spoken).join(' ')}</span>}
  </kbd>;
}

/** A combination written by hand: keys 4px apart, announced as one. */
function KbdGroup({
  className,
  ...props
}) {
  return <kbd data-slot="kbd-group" className={cn('inline-flex max-w-full flex-wrap items-center gap-1 font-[inherit]', className)} {...props}/>;
}

export { Kbd, KbdGroup, shortcut };
