'use client';;
import * as React from 'react';
import {createPortal} from 'react-dom';
import {useGlazePortal} from '@/lib/glaze/portal';
import {menuItemClass, menuLabelClass, overlayMotion, overlaySurface} from '@/lib/glaze/overlay';
import {cn} from '@/lib/glaze/utils';

// The list @ and / open beside the caret. It is a listbox the editor drives through aria-activedescendant, so focus
// stays in the text; the command menu over a draft adds its own search field on top. It is Glaze's menu: the overlay
// surface (paper, a 1px ring, no shadow) with the shared list rows (32px, the 6px tag corner, a wash when highlighted).
// The type of each option is a quiet word at its end.

// Where the list sits against the caret and the window, in px: the gap to the caret, the room kept at the window's
// edges, and the least height a list below the caret is given.
const CARET_GAP = 6;
const EDGE_ROOM = 16;
const MIN_HEIGHT = 120;
const MENU_WIDTH = 320;
const POPUP_MAX = 320;

/**
 * How well a label matches the query, lower first: exact, then a whole-word prefix ("run" in "run 4812"), then a
 * prefix, then a word start, then anywhere. `query` is lower case. The sort is stable, so ties keep the caller's order.
 */
function matchRank(label, query) {
  const l = label.toLowerCase();
  if (!query || l === query) return 0;
  if (l.startsWith(query)) return /[a-z0-9]/i.test(l.charAt(query.length)) ? 2 : 1;
  for (let at = l.indexOf(query, 1); at > 0; at = l.indexOf(query, at + 1)) if (!/[a-z0-9]/i.test(l.charAt(at - 1))) return 3;
  return 4;
}

function TriggerMenu({
  id,
  menu,
  title,
  empty,
  options,
  active,
  onHover,
  onPick,
  typeLabel,
  search
}) {
  const container = useGlazePortal();
  const listRef = React.useRef(null);
  const [style, setStyle] = React.useState({visibility: 'hidden'});

  React.useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE_ROOM);
    const left = Math.max(EDGE_ROOM, Math.min(menu.rect.left - 8, window.innerWidth - width - EDGE_ROOM));
    const room = menu.rect.top - EDGE_ROOM;
    const above = room > Math.min(el.scrollHeight, POPUP_MAX) + 8;
    setStyle(above
      ? {position: 'fixed', left, width, bottom: window.innerHeight - menu.rect.top + CARET_GAP, maxHeight: Math.min(POPUP_MAX, room - 8)}
      : {position: 'fixed', left, width, top: menu.rect.bottom + CARET_GAP, maxHeight: Math.max(MIN_HEIGHT, Math.min(POPUP_MAX, window.innerHeight - menu.rect.bottom - EDGE_ROOM))});
  }, [menu.rect, options.length]);

  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [active]);

  if (container === null) return null;
  return createPortal(<div
    ref={listRef}
    data-slot="prompt-input-menu"
    data-menu={menu.kind}
    onMouseDown={event => { if (!(event.target).closest('input')) event.preventDefault(); }}
    // The position is measured from the caret each frame it moves, so it is set inline; it is not a style choice.
    style={style}
    className={cn('isolate z-(--z-overlay) flex flex-col overflow-hidden [--menu-item-h:var(--menu-row)]', overlaySurface, overlayMotion, 'starting:opacity-0')}
  >
    {search}
    <div id={id} role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
      <p className={menuLabelClass} aria-hidden>{title}</p>
      {options.length === 0 && <p data-slot="prompt-input-menu-empty" role="presentation" className="flex min-h-(--menu-row) items-center px-2 type-body-sm text-text-2">{empty}</p>}
      {options.map((option, i) => <div
        key={option.key}
        id={`${id}-${i}`}
        role="option"
        aria-selected={i === active}
        data-index={i}
        data-highlighted={i === active || undefined}
        onMouseMove={() => onHover(i)}
        onClick={() => onPick(option)}
        className={cn(menuItemClass, option.description && 'py-1')}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{option.mention.type === 'command' ? '/' : ''}{option.mention.label}</span>
          {option.description && <span className="truncate type-caption text-text-2">{option.description}</span>}
        </span>
        {option.detail
          ? <span dir="ltr" className="max-w-1/2 shrink-0 truncate type-code-xs text-text-2">{option.detail}</span>
          : <span className="shrink-0 type-caption text-text-2">{typeLabel(option)}</span>}
      </div>)}
    </div>
  </div>, container ?? document.body);
}

export { TriggerMenu, matchRank };
