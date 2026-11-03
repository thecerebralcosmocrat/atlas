'use client';;
import * as React from 'react';
import {Menu as MenuPrimitive} from '@base-ui/react/menu';
import {ContextMenu as ContextMenuPrimitive} from '@base-ui/react/context-menu';
import {menuCheckItemClass, menuItemClass, menuLabelClass, menuPopupClass, menuSeparatorClass} from '@/lib/glaze/overlay';
import {Icon, ChevronRight, Check} from '@/components/glaze/icon';
import {Kbd} from '@/components/glaze/ui/kbd';
import {cn, mergeClass} from '@/lib/glaze/utils';
import {useGlazePortal} from '@/lib/glaze/portal';

const MenuContext = React.createContext({mode: 'click', mark: () => {}, pressed: {current: null}});

// The popup, rows, labels and rules are lib/overlay.ts's list recipe, which Command and the other list popups share.
// The highlighted row is the focus indicator: the popup and its rows take no ring of their own.
const menuShortcutClass = 'ms-auto flex shrink-0 items-center gap-1 ps-4';

/** The row a context menu acts on, found from where it opened. */
const TARGET = '[data-menu-target], tr, [role="row"], li';

/** The row around `from` inside a context-menu area (`area`, or the nearest one), or null. */
function rowOf(from, area) {
  if (!(from instanceof Element)) return null;
  const row = from.closest(TARGET);
  const within = area ?? row?.closest('[data-menu-area]');
  return row && within && within.contains(row) && row !== within ? row : null;
}

function DropdownMenu({
  trigger = 'click',
  onOpenChange,
  onTargetChange,
  ...props
}) {
  const target = React.useRef(null);
  const pressed = React.useRef(null);
  const onTarget = React.useRef(onTargetChange);
  React.useLayoutEffect(() => { onTarget.current = onTargetChange; });
  const mark = React.useCallback((row) => {
    if (row === target.current) return;
    target.current?.removeAttribute('data-menu-target-open');
    target.current = row;
    row?.setAttribute('data-menu-target-open', '');
    onTarget.current?.(row);
  }, []);
  const state = React.useMemo(() => ({mode: trigger, mark, pressed}), [trigger, mark]);
  const change = (open, details) => {
    if (open && !target.current) {
      // A long press on touch opens the menu without a contextmenu event on some phones, so mark the row
      // the finger went down on. A click menu marks the row its button sits in.
      mark(trigger === 'contextmenu' ? pressed.current : rowOf(details.event?.target));
    }
    if (!open) { mark(null); pressed.current = null; }
    onOpenChange?.(open, details);
  };
  return (
    <MenuContext.Provider value={state}>
      {trigger === 'contextmenu'
        ? <ContextMenuPrimitive.Root data-slot="dropdown-menu" onOpenChange={change} {...(props)}/>
        : <MenuPrimitive.Root data-slot="dropdown-menu" onOpenChange={change} {...props}/>}
    </MenuContext.Provider>
  );
}

function DropdownMenuPortal(props) {
  const container = useGlazePortal();
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" container={container} {...props}/>;
}

function DropdownMenuTrigger({
  selectable = false,
  className,
  ...props
}) {
  const {mode, mark, pressed} = React.useContext(MenuContext);
  if (mode === 'contextmenu') {
    const base = cn(
      !selectable && 'select-none',
      // The row the menu acts on: the selected-row wash, so it reads after the pointer has moved into the menu.
      '[&_[data-menu-target-open]]:bg-pressed',
      'forced-colors:[&_[data-menu-target-open]]:outline-solid forced-colors:[&_[data-menu-target-open]]:outline-2 forced-colors:[&_[data-menu-target-open]]:-outline-offset-2',
    );
    return (
      <ContextMenuPrimitive.Trigger
        data-slot="dropdown-menu-trigger"
        data-menu-area=""
        data-selectable={selectable || undefined}
        onPointerDown={event => { if (event.pointerType !== 'mouse') pressed.current = rowOf(event.target, event.currentTarget); }}
        onContextMenu={event => { mark(rowOf(event.target, event.currentTarget)); }}
        onKeyDown={event => {
          // Shift+F10 opens the menu at the focused row, as the Menu key does natively: a contextmenu
          // event at the row's centre, which Base UI opens on and mark() reads.
          if (!(event.shiftKey && event.key === 'F10')) return;
          const from = document.activeElement;
          if (!from || !event.currentTarget.contains(from)) return;
          event.preventDefault();
          const box = from.getBoundingClientRect();
          // Near the row's reading start: its left, or its right in right-to-left text.
          const inset = Math.min(box.width / 2, 160);
          const x = getComputedStyle(from).direction === 'rtl' ? box.right - inset : box.left + inset;
          from.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, button: 2}));
        }}
        className={mergeClass(base, className)}
        {...(props)}
      />
    );
  }
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" className={className} {...props}/>;
}

function DropdownMenuContent({
  align,
  alignOffset,
  side,
  sideOffset,
  collisionPadding = 8,
  collisionAvoidance,
  anchor,
  size = 'default',
  className,
  ...props
}) {
  const {mode} = React.useContext(MenuContext);
  // A click menu takes its name from its trigger; a context menu has no trigger button, so it needs
  // one. Pass the row's name ("Actions for run_8f2a"); "Actions" is the fallback.
  const popup = <MenuPrimitive.Popup data-slot="dropdown-menu-content" data-size={size} aria-label={mode === 'contextmenu' ? 'Actions' : undefined} className={mergeClass(menuPopupClass, className)} {...props}/>;
  return <DropdownMenuPortal>
    {mode === 'contextmenu'
      ? <ContextMenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align ?? 'start'} alignOffset={alignOffset ?? 4} side={side ?? 'inline-end'} sideOffset={sideOffset ?? 0} collisionPadding={collisionPadding} collisionAvoidance={collisionAvoidance}>{popup}</ContextMenuPrimitive.Positioner>
      : <MenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align ?? 'start'} alignOffset={alignOffset ?? 0} side={side ?? 'bottom'} sideOffset={sideOffset ?? 6} collisionPadding={collisionPadding} collisionAvoidance={collisionAvoidance} anchor={anchor}>{popup}</MenuPrimitive.Positioner>}
  </DropdownMenuPortal>;
}

function DropdownMenuGroup(props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props}/>;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" data-inset={inset || undefined} className={mergeClass(menuLabelClass, className)} {...props}/>;
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}) {
  return <MenuPrimitive.Item
    data-slot="dropdown-menu-item"
    data-inset={inset || undefined}
    data-variant={variant}
    data-status={variant === 'destructive' ? 'fail' : undefined}
    className={mergeClass(menuItemClass, className)}
    {...props}
  />;
}

/** An item that navigates: a real link, so open in a new tab and copy link work (trap/menu-navigation). */
function DropdownMenuLinkItem({
  className,
  inset,
  ...props
}) {
  return <MenuPrimitive.LinkItem
    data-slot="dropdown-menu-link-item"
    data-inset={inset || undefined}
    className={mergeClass([menuItemClass, 'cursor-pointer'], className)}
    {...props}
  />;
}

function DropdownMenuSub(props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props}/>;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}) {
  return <MenuPrimitive.SubmenuTrigger
    data-slot="dropdown-menu-sub-trigger"
    data-inset={inset || undefined}
    className={mergeClass([menuItemClass, 'data-popup-open:bg-hover forced-colors:data-popup-open:outline-solid forced-colors:data-popup-open:outline-1 forced-colors:data-popup-open:-outline-offset-1'], className)}
    {...props}
  >
    {children}
    <Icon icon={ChevronRight} className="ms-auto rtl:-scale-x-100"/>
  </MenuPrimitive.SubmenuTrigger>;
}

function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -5,
  side = 'inline-end',
  sideOffset = 4,
  className,
  collisionPadding = 8,
  collisionAvoidance,
  anchor: _anchor,
  size = 'default',
  ...props
}) {
  // A submenu always positions against its parent item, whichever way the root opened.
  return <DropdownMenuPortal>
    <MenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} collisionPadding={collisionPadding} collisionAvoidance={collisionAvoidance}>
      <MenuPrimitive.Popup data-slot="dropdown-menu-sub-content" data-size={size} className={mergeClass(menuPopupClass, className)} {...props}/>
    </MenuPrimitive.Positioner>
  </DropdownMenuPortal>;
}

function DropdownMenuCheckboxItem({
  className,
  children,
  inset,
  ...props
}) {
  return <MenuPrimitive.CheckboxItem
    data-slot="dropdown-menu-checkbox-item"
    data-inset={inset || undefined}
    className={mergeClass(menuCheckItemClass, className)}
    {...props}
  >
    <span data-slot="dropdown-menu-checkbox-item-indicator" className="pointer-events-none absolute start-2 flex size-(--icon) items-center justify-center">
      <MenuPrimitive.CheckboxItemIndicator className="tick-draw flex [&_svg]:text-text-1"><Icon icon={Check}/></MenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>;
}

function DropdownMenuRadioGroup(props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props}/>;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}) {
  return <MenuPrimitive.RadioItem
    data-slot="dropdown-menu-radio-item"
    data-inset={inset || undefined}
    className={mergeClass(menuCheckItemClass, className)}
    {...props}
  >
    <span data-slot="dropdown-menu-radio-item-indicator" className="pointer-events-none absolute start-2 flex size-(--icon) items-center justify-center">
      {/* The chosen option takes the checkbox item's check: a menu marks a choice with a glyph, never a dot. */}
      <MenuPrimitive.RadioItemIndicator className="tick-draw flex [&_svg]:text-text-1"><Icon icon={Check}/></MenuPrimitive.RadioItemIndicator>
    </span>
    {children}
  </MenuPrimitive.RadioItem>;
}

function DropdownMenuSeparator({
  className,
  ...props
}) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={mergeClass(menuSeparatorClass, className)} {...props}/>;
}

/** The item's shortcut, one key cap per key, from keys or from a string child, at the row's inline end. */
function DropdownMenuShortcut({
  className,
  keys,
  children,
  ...props
}) {
  const caps = keys ?? (typeof children === 'string' ? [children] : null);
  return <kbd data-slot="dropdown-menu-shortcut" className={cn(menuShortcutClass, className)} {...props}>
    {caps ? caps.map((key, i) => <Kbd key={i}>{key}</Kbd>) : children}
  </kbd>;
}

export { DropdownMenu, DropdownMenuPortal, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuLinkItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent };
