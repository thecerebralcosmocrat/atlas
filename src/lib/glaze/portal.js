'use client';;
import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

const GlazePortalContext = createContext(undefined);

const noLock = () => () => {};

/** Sets inert on every element outside `keep`, from its parent up to body. Returns the undo. */
function inertOutside(keep) {
  const set = [];
  let node = keep;
  while (node && node !== node.ownerDocument.body) {
    const parent = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling.tagName === 'SCRIPT') continue;
      sibling.inert = true;
      set.push(sibling);
    }
    node = parent;
  }
  return () => { for (const el of set) el.inert = false; };
}

export function GlazePortalProvider({
  children,
  dir
}) {
  const parent = useContext(GlazePortalContext);
  const [container, setContainer] = useState(null);
  const count = useRef(0);
  const undo = useRef(null);
  const role = !parent ? 'root' : dir ? 'dir' : 'stage';

  const scope = useMemo(() => {
    if (role === 'dir') return {container, lock: parent.lock};
    if (role === 'stage') return {container, lock: noLock};
    return {
      container,
      lock: () => {
        count.current += 1;
        if (count.current === 1 && container) undo.current = inertOutside(container);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          count.current -= 1;
          if (count.current === 0) { undo.current?.(); undo.current = null; }
        };
      },
    };
  }, [role, container, parent]);

  // `dir` with no provider above: GlazeDirection at the root, before the root provider. Pass through.
  if (!parent && dir) return createElement(Fragment, null, children);

  const element = createElement('div', {ref: setContainer, 'data-glaze-portal': role, dir: role === 'dir' ? dir : undefined});
  return createElement(GlazePortalContext.Provider, {value: scope},
    children,
    role === 'dir' ? (parent.container ? createPortal(element, parent.container) : null) : element,
  );
}

export function useGlazePortal() {
  return useContext(GlazePortalContext)?.container;
}

/**
 * Makes the page behind inert while `active` is true. Call it from a modal overlay's popup with its
 * open state, not its mounted state: the lock lifts in the same commit that closes it, before Base UI
 * returns focus to the trigger on the page.
 */
export function useGlazeModal(active) {
  const scope = useContext(GlazePortalContext);
  const lock = scope?.lock;
  const ready = !!scope?.container;
  useLayoutEffect(() => {
    if (!active || !lock || !ready) return;
    return lock();
  }, [active, lock, ready]);
}

const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

/** The visible tabbable elements inside a popup, in DOM order, without Base UI's focus guards. */
function tabbablesIn(popup) {
  return Array.from(popup.querySelectorAll(TABBABLE)).filter(el => {
    if (el.matches(':disabled, [data-base-ui-focus-guard], [aria-hidden="true"]') || el.tabIndex < 0) return false;
    if (el.closest('[inert]') || el.closest('[hidden]')) return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
}

/**
 * Tab from the last control goes to the first, and Shift+Tab from the first goes to the last. Base UI's
 * focus guards sit at both ends of a popup and the browser stops on them (and on body) before focus
 * returns; handling the key here skips both stops. Call it from the popup's keydown. Keys that bubble
 * through the React tree from a nested overlay are ignored, since that overlay cycles itself.
 */
export function cycleTab(event) {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const popup = event.currentTarget;
  const target = event.target;
  if (!popup.contains(target)) return;
  const stops = tabbablesIn(popup);
  if (!stops.length) { event.preventDefault(); popup.focus(); return; }
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (event.shiftKey && (target === first || target === popup)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && target === last) { event.preventDefault(); first.focus(); }
}

/** True when the primary pointer is coarse: a finger, where focusing a text field raises the keyboard. */
export function coarsePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
