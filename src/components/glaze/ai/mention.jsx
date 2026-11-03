import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva} from 'class-variance-authority';
import {Icon, Close} from '@/components/glaze/icon';
import { cn } from '@/lib/glaze/utils';

const mentionTypeLabels = {
  agent: 'Agent', run: 'Run', deploy: 'Deployment', key: 'Key', model: 'Model',
  file: 'File', folder: 'Folder', doc: 'Doc', table: 'Table', web: 'Web page', command: 'Command', paste: 'Pasted text',
};

const mentionTypes = new Set(Object.keys(mentionTypeLabels));

// ---------- The serialized form ----------

// A lone surrogate half cannot be URI-encoded (encodeURIComponent throws), so it becomes U+FFFD first.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** An id as it sits in the text form. encodeURIComponent leaves parens alone, and a ")" would end the link. */
const encodeMentionId = (id) => encodeURIComponent(id.replace(loneSurrogate, '�')).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const labelEscapes = {'\\': '\\\\', '[': '\\[', ']': '\\]', '\n': '\\n', '\r': '\\r'};
const labelUnescapes = {n: '\n', r: '\r'};

/**
 * `[label](type:id)`. Brackets, backslashes and line breaks in a label are escaped and parens in the id encoded, so
 * every chip, an empty id or label included, parses back to itself.
 */
function mentionToText({
  type,
  id,
  label
}) {
  return `[${label.replace(/[\\[\]\n\r]/g, m => labelEscapes[m])}](${type}:${encodeMentionId(id)})`;
}

// An optional @ or / in front is the legacy prefix; it is read and dropped.
const tokenPattern = /[@/]?\[((?:\\.|[^\]\\\n])*)\]\(([a-z]+):([^)\s]*)\)/g;

/** Splits text into plain runs and mentions. Unknown types stay text, so a markdown link is never eaten. */
function parseMentions(source) {
  const tokens = [];
  let last = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const [whole, rawLabel, type, rawId] = match;
    if (!mentionTypes.has(type)) continue;
    let id = rawId;
    try { id = decodeURIComponent(rawId); } catch {}
    if (match.index > last) tokens.push({kind: 'text', text: source.slice(last, match.index)});
    tokens.push({kind: 'mention', mention: {type: type, id, label: rawLabel.replace(/\\(.)/g, (_, c) => labelUnescapes[c] ?? c)}});
    last = match.index + whole.length;
  }
  if (last < source.length) tokens.push({kind: 'text', text: source.slice(last)});
  return tokens;
}

/**
 * A label no other chip in `taken` uses: "policy.md", then "policy.md (2)". Two different files with the same name
 * never collapse into one chip, and the same id keeps its label.
 */
function uniqueLabel(next, taken) {
  const same = taken.find(m => m.type === next.type && m.id === next.id);
  if (same) return same.label;
  const labels = new Set(taken.map(m => m.label));
  if (!labels.has(next.label)) return next.label;
  let n = 2;
  while (labels.has(`${next.label} (${n})`)) n += 1;
  return `${next.label} (${n})`;
}

// ---------- The chip ----------

const mentionVariants = cva(
  [
    'group/mention inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-tag border border-line-control bg-paper px-1.5 align-bottom whitespace-nowrap',
    'type-label text-text-1 no-underline select-none',
    'transition-[background-color,border-color] duration-(--dur-state) ease-out',
    '[a]:hover:bg-hover [button]:hover:bg-hover [a,button]:cursor-pointer',
    'aria-disabled:text-text-disabled data-missing:border-line-faint data-missing:text-text-2 data-missing:line-through data-missing:decoration-1',
    'forced-colors:border-[CanvasText]',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {removable: {true: 'pe-0', false: ''}},
    defaultVariants: {removable: false},
  },
);

function Mention({
  type,
  missing,
  onRemove,
  removeLabel,
  missingLabel = ' (no longer exists)',
  render,
  className,
  children,
  ...props
}) {
  const text = typeof children === 'string' ? children : undefined;
  // The remove button is 20px so the chip's line does not grow, which is why it is not a Button: after:-inset-1 makes
  // its target 28px.
  const label = <>
    <span data-slot="mention-label" className="min-w-0 truncate" title={text && text.length > 24 ? text : undefined}>{type === 'command' ? '/' : ''}{children}</span>
    {missing && <span className="sr-only">{missingLabel}</span>}
    {onRemove && <button
      type="button"
      data-slot="mention-remove"
      aria-label={removeLabel ?? `Remove ${text ?? mentionTypeLabels[type]}`}
      onClick={event => {
        // The button unmounts with its chip. Hand focus to the next chip's remove button in the same list, else the
        // previous one; with none left, the caller's onRemove decides (focus your field there).
        const list = event.currentTarget.closest('ul, ol, [role="list"], [role="group"]') ?? event.currentTarget.parentElement?.parentElement;
        const all = list ? [...list.querySelectorAll('[data-slot="mention-remove"]')] : [];
        const at = all.indexOf(event.currentTarget);
        const next = all[at + 1] ?? all[at - 1];
        onRemove();
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (next?.isConnected && (!active || active === document.body || !active.isConnected)) next.focus();
        });
      }}
      className="relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-tag text-text-2 transition-colors duration-(--dur-state) ease-out after:absolute after:-inset-1 hover:bg-hover hover:text-text-1 focus-visible:focus-ring-inset"
    ><Icon icon={Close} size={12}/></button>}
  </>;
  return useRender({
    defaultTagName: 'span',
    props: mergeProps(
      {className: cn(mentionVariants({removable: !!onRemove}), className), children: label},
      {
        'data-slot': 'mention',
        'data-type': type,
        'data-missing': missing || undefined
      },
      props
    ),
    render,
    state: {slot: 'mention', type},
  });
}

export { Mention, mentionVariants, mentionTypeLabels, mentionToText, encodeMentionId, parseMentions, uniqueLabel };
