'use client';;
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {Input as InputPrimitive} from '@base-ui/react/input';
import {Icon, Close, Hide, Pending, Search, Show} from '@/components/glaze/icon';
import {cn, mergeClass, mergeRefs} from '@/lib/glaze/utils';
import { Button } from '@/components/glaze/ui/button';
import {CopyButton} from '@/components/glaze/ui/copy-button';
import {useFieldDisabled} from '@/components/glaze/ui/field';
import {Kbd} from '@/components/glaze/ui/kbd';

const SizeContext = createContext('default');

// Each size sets --input-h, the height token. The pill takes max(the token, one line plus 8px), so it grows with the
// text at 200% zoom instead of clipping it, and an action inside takes the token less the 3px inset and the line.
// The box takes its size's text role too, so that one line (1lh) is the text's, not the recipe's 13px body-sm: on
// the 19.5px body-sm line a small pill came out 27.5px, not 26.
const boxSize = {
  sm: '[--input-h:var(--control-sm)] type-caption',
  default: '[--input-h:var(--control)] type-body-sm',
  lg: '[--input-h:var(--control-lg)] type-body',
};
const textSize = {sm: 'type-caption', default: 'type-body-sm', lg: 'type-body'};
// Mono at 0.8 of the sans it replaces, through the standalone code roles: 9.6, 10.4 and 11.2px.
const monoSize = {sm: 'type-code-xs', default: 'type-code-sm', lg: 'type-code'};
const slotSize = {
  sm: 'type-label-sm [&_svg]:size-(--icon-sm)',
  default: 'type-label-sm [&_svg]:size-(--icon)',
  lg: 'type-label [&_svg]:size-(--icon-lg)',
};

/** The control's own disabled prop, or a disabled Field or FieldSet around it. Slots and actions read it too. */
function useOff(disabled) {
  const inField = useFieldDisabled();
  return !!disabled || inField;
}

/** The pill: the field recipe around the text and its slots. A press anywhere but a button focuses the text. */
function InputRoot({
  size = 'default',
  disabled,
  readOnly,
  className,
  onPointerDown,
  children,
  ...props
}) {
  const down = (e) => {
    onPointerDown?.(e);
    if ((e.target).closest('button, a, input, textarea, [role=button]')) return;
    const control = e.currentTarget.querySelector('[data-control]');
    if (!control || disabled) return;
    e.preventDefault();
    control.focus();
  };
  return <SizeContext.Provider value={size}>
    <div
      data-slot="input"
      data-size={size}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      onPointerDown={down}
      className={cn(
        'field group/input w-full cursor-text [--field-h:max(var(--input-h),calc(1lh+var(--space-2)))]',
        '[--action-h:calc(var(--input-h)-2*var(--shell-inset)-2*var(--line-width))]',
        boxSize[size],
        // Read-only drops to the faint line until it takes the cursor: a value to read and copy, not to type.
        'data-readonly:cursor-default data-readonly:not-focus-within:border-line-faint data-disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    >{children}</div>
  </SizeContext.Provider>;
}

const slotClass = 'flex shrink-0 items-center gap-1 text-text-2 select-none [&_svg]:shrink-0 [&_svg]:text-text-3 group-data-disabled/input:text-text-disabled [unicode-bidi:plaintext]';

/** Before the text: an icon, a scheme such as "https://", a currency sign. An InputAction here sits 3px from the line. */
function InputLeading({
  className,
  ...props
}) {
  const size = useContext(SizeContext);
  return <span
    data-slot="input-leading"
    className={cn(slotClass, slotSize[size], 'has-[>[data-slot=input-action]:first-child]:-ms-[calc(var(--space-3)-var(--shell-inset))]', className)}
    {...props}
  />;
}

/** After the text: a unit, a key hint, or InputAction buttons, the last one 3px from the line. */
function InputTrailing({
  className,
  ...props
}) {
  const size = useContext(SizeContext);
  return <span
    data-slot="input-trailing"
    className={cn(slotClass, slotSize[size], 'has-[>[data-slot=input-action]:last-child]:-me-[calc(var(--space-3)-var(--shell-inset))]', className)}
    {...props}
  />;
}

/** The bare text control inside the pill. The pill draws the paper and the line, and shows its focus. */
function InputControl({
  className,
  mono,
  ...props
}) {
  const size = useContext(SizeContext);
  return <InputPrimitive
    data-slot="input-control"
    data-control=""
    className={mergeClass([
      'h-full w-full min-w-0 flex-1 truncate bg-transparent text-inherit',
      mono ? monoSize[size] : textSize[size],
      'disabled:cursor-not-allowed read-only:cursor-default',
      'file:me-2 file:cursor-pointer file:rounded-pill file:bg-field file:px-2 file:type-label-sm file:text-text-1',
      '[&::-webkit-search-cancel-button]:appearance-none',
    ], className)}
    {...props}
  />;
}

/**
 * A Button sized to sit inside the pill, 3px inside its line: show, clear, copy, or the field's one action ("Join").
 * Ghost by default; variant="primary" for a field that is a one-line form, and then the only ink in its group.
 */
function InputAction({
  className,
  size = 'icon',
  variant = 'ghost',
  ...props
}) {
  const box = useContext(SizeContext);
  return <Button
    data-slot="input-action"
    variant={variant}
    size={size === 'icon' ? 'icon-sm' : 'sm'}
    className={mergeClass([
      'h-(--action-h)',
      size === 'icon' ? 'w-(--action-h)' : 'px-2.5',
      box === 'lg' ? 'type-label [&_svg]:size-(--icon)' : 'type-label-sm [&_svg]:size-(--icon-sm)',
    ], className)}
    {...props}
  />;
}

/** Splits the box's props (forced states, style) from the props meant for the text control. */
function splitBox(props) {
  const box = {};
  const rest = {};
  for (const [k, v] of Object.entries(props)) (k.startsWith('data-force-') || k === 'style' ? box : rest)[k] = v;
  return {box, rest: rest};
}

function useControllable(value, defaultValue, onChange) {
  const [inner, setInner] = useState(defaultValue);
  const current = value !== undefined ? value : inner;
  const set = (next) => { if (value === undefined) setInner(next); onChange?.(next); };
  return [current, set];
}

const isInvalid = (rest) => rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';

function Input(props) {
  switch (props.mode) {
    case 'password': return <PasswordMode {...props}/>;
    case 'search': return <SearchMode {...props}/>;
    case 'copy': return <CopyMode {...props}/>;
    default: return <TextMode {...props}/>;
  }
}

function TextMode({
  mode: _mode,
  size = 'default',
  leading,
  trailing,
  className,
  controlClassName,
  mono,
  disabled: disabledProp,
  readOnly,
  type = 'text',
  ...all
}) {
  const disabled = useOff(disabledProp);
  const {box, rest} = splitBox(all);
  return <InputRoot size={size} disabled={disabled} readOnly={readOnly} className={className} data-mode="text" data-invalid={isInvalid(rest) || undefined} {...box}>
    {leading !== undefined && <InputLeading>{leading}</InputLeading>}
    <InputControl type={type} disabled={disabled} readOnly={readOnly} mono={mono} className={controlClassName} {...rest}/>
    {trailing !== undefined && <InputTrailing>{trailing}</InputTrailing>}
  </InputRoot>;
}

function PasswordMode({
  mode: _mode,
  size = 'default',
  leading,
  trailing: _trailing,
  className,
  controlClassName,
  mono: _mono,
  value,
  defaultValue = '',
  onValueChange,
  onChange,
  defaultRevealed = false,
  disabled: disabledProp,
  autoComplete,
  ...all
}) {
  const disabled = useOff(disabledProp);
  const {box, rest} = splitBox(all);
  const [current, set] = useControllable(value, defaultValue, onValueChange);
  const [revealed, setRevealed] = useState(defaultRevealed);
  return (
    <InputRoot size={size} disabled={disabled} className={className} data-mode="password" {...box}>
      {leading !== undefined && <InputLeading>{leading}</InputLeading>}
      <InputControl
        type={revealed ? 'text' : 'password'}
        value={current}
        onChange={(e) => { set(e.target.value); onChange?.(e); }}
        disabled={disabled}
        autoComplete={autoComplete ?? 'current-password'}
        autoCapitalize="off"
        spellCheck={false}
        mono={revealed}
        className={controlClassName}
        {...rest}
      />
      <InputTrailing>
        <InputAction
          disabled={disabled}
          aria-pressed={revealed}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          onClick={() => setRevealed(r => !r)}
        ><Icon icon={revealed ? Hide : Show}/></InputAction>
      </InputTrailing>
    </InputRoot>
  );
}

const isEditable = (el) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

const shortcuts = new Set();
function onShortcutKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isEditable(e.target)) return;
  // An open listbox or combobox owns every printable key for its typeahead.
  if (e.target instanceof Element && e.target.closest('[role=listbox], [role=option], [role=combobox], [role=tree], [role=grid]')) return;
  // Inside an open dialog or menu the key stays there; it never pulls focus to a field behind the overlay.
  const layer = e.target instanceof Element ? e.target.closest('[role=dialog], [role=alertdialog], [role=menu]') : null;
  const owners = [...shortcuts]
    .filter(entry => entry.key === e.key && entry.el()?.isConnected && (!layer || layer.contains(entry.el())))
    .map(entry => entry.el())
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  if (!owners.length) return;
  e.preventDefault();
  owners[0].focus();
}
function claimShortcut(entry) {
  if (!shortcuts.size) window.addEventListener('keydown', onShortcutKey);
  shortcuts.add(entry);
  return () => {
    shortcuts.delete(entry);
    if (!shortcuts.size) window.removeEventListener('keydown', onShortcutKey);
  };
}

function SearchMode({
  mode: _mode,
  size = 'default',
  leading: _leading,
  trailing: _trailing,
  className,
  controlClassName,
  mono: _mono,
  value,
  defaultValue = '',
  onValueChange,
  onChange,
  shortcut,
  shortcutOwner = true,
  clearLabel = 'Clear search',
  pending,
  disabled: disabledProp,
  onKeyDown,
  ref,
  ...all
}) {
  const disabled = useOff(disabledProp);
  const {box, rest} = splitBox(all);
  const [current, set] = useControllable(value, defaultValue, onValueChange);
  const inner = useRef(null);
  const setRef = useMemo(() => mergeRefs(inner, ref), [ref]);

  useEffect(() => {
    if (!shortcut || !shortcutOwner || disabled) return;
    return claimShortcut({el: () => inner.current, key: shortcut});
  }, [shortcut, shortcutOwner, disabled]);

  return (
    <InputRoot size={size} disabled={disabled} className={className} data-mode="search" data-pending={pending || undefined} {...box}>
      <InputLeading>{pending
        ? <Icon icon={Pending} className="animate-spin motion-reduce:animate-none"/>
        : <Icon icon={Search}/>}</InputLeading>
      <InputControl
        ref={setRef}
        type="search"
        value={current}
        disabled={disabled}
        onChange={(e) => { set(e.target.value); onChange?.(e); }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
          if (current) { e.preventDefault(); e.stopPropagation(); set(''); }
          else inner.current?.blur();
        }}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-busy={pending || undefined}
        className={controlClassName}
        {...rest}
      />
      {current && !disabled
        ? <InputTrailing>
            <InputAction aria-label={clearLabel} onClick={() => { set(''); inner.current?.focus(); }}><Icon icon={Close}/></InputAction>
          </InputTrailing>
        // A touch phone has no "/" key, so the hint hides where the pointer is coarse.
        : shortcut && <InputTrailing aria-hidden className="pointer-coarse:hidden"><Kbd>{shortcut}</Kbd></InputTrailing>}
    </InputRoot>
  );
}

function CopyMode({
  mode: _mode,
  size = 'default',
  leading,
  trailing: _trailing,
  className,
  controlClassName,
  value,
  noun,
  onCopy,
  mono = true,
  forceCopyState,
  disabled: disabledProp,
  ...all
}) {
  const disabled = useOff(disabledProp);
  const {box, rest} = splitBox(all);
  return (
    <InputRoot size={size} disabled={disabled} readOnly className={className} data-mode="copy" {...box}>
      {leading !== undefined && <InputLeading>{leading}</InputLeading>}
      <InputControl
        readOnly
        value={value}
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        mono={mono}
        className={controlClassName}
        {...rest}
      />
      <InputTrailing>
        <CopyButton
          data-slot="input-action"
          value={value}
          label={noun}
          onCopy={onCopy}
          forceState={forceCopyState}
          disabled={disabled || !value}
          size="icon-sm"
          className={cn('size-(--action-h)', size === 'lg' ? '[&_svg]:size-(--icon)' : '[&_svg]:size-(--icon-sm)')}
        />
      </InputTrailing>
    </InputRoot>
  );
}

export { Input, InputAction, InputControl, InputLeading, InputRoot, InputTrailing };
