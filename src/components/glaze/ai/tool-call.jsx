'use client';;
import {Collapsible as CollapsiblePrimitive} from '@base-ui/react/collapsible';
import {useCallback, useEffect, useId, useMemo, useReducer, useRef, useState} from 'react';
import {Button} from '@/components/glaze/ui/button';
import {Card, CardContent, CardFooter, CardHeader, CardTitle} from '@/components/glaze/ui/card';
import {statusLabels} from '@/components/glaze/ui/status';
import {
  ActivityGroup,
  Disclosure,
  StepGlyph,
  formatCount,
  formatElapsed,
  joinSummary,
  pastTense,
  pickActivity,
  rowVariants,
  splitForce,
} from '@/components/glaze/ai/activity';
import { RequestSummary, RequestTicker, ShowMoreRow, summarizeRequests } from '@/components/glaze/ai/request-ticker';
import {cn, mergeRefs} from '@/lib/glaze/utils';

const terminal = new Set(['completed', 'error', 'denied', 'cancelled']);
const isTerminal = (status) => terminal.has(status);

const emptyState = {calls: [], gen: 0, stopped: false, dropped: 0};
const NO_STATUS = 'The tool ended without reporting a result.';
/** Characters a collapsed output shows per line of its cap, so one long line cannot fill the thread. */
const CHARS_PER_LINE = 120;

/** An event's time in epoch ms, or now when it has none or it is not a finite number. */
const timeOf = (at) => typeof at === 'number' && Number.isFinite(at) ? at : Date.now();

function transition(call, e) {
  const at = timeOf(e.at);
  switch (e.type) {
    case 'call': return {...call, tool: e.tool, input: e.input ?? call.input, raw: e.raw ?? call.raw, status: 'pending'};
    case 'input': return {...call, raw: e.raw, input: e.input ?? call.input};
    case 'start': return {...call, tool: e.tool ?? call.tool, input: e.input ?? call.input, title: e.title ?? call.title, status: 'running', startedAt: call.startedAt ?? at};
    case 'progress': return {...call, metadata: {...call.metadata, ...e.metadata}, title: e.title ?? call.title, status: call.status === 'pending' ? 'running' : call.status, startedAt: call.startedAt ?? at};
    case 'ask': return {...call, status: 'awaiting-permission', permission: {patterns: e.patterns, message: e.message}};
    case 'reply': return e.reply === 'reject'
      ? {...call, status: 'denied', reason: e.feedback, endedAt: at}
      : {...call, status: 'running', startedAt: call.startedAt ?? at};
    case 'result': {
      const status = e.status ?? 'error';
      return {
        ...call, status, output: e.output ?? call.output, title: e.title ?? call.title,
        metadata: e.metadata ? {...call.metadata, ...e.metadata} : call.metadata,
        error: status === 'error' ? (e.error ?? (e.status ? 'The tool failed.' : NO_STATUS)) : undefined,
        endedAt: at,
      };
    }
  }
}

/**
 * The one reducer every view uses, so a call reads the same in a chat, a console and a canvas. Monotonic per call,
 * terminal states absorb, results before calls are kept, stop is generation-keyed.
 */
function toolCallsReducer(state, e) {
  if (e.type === 'reset') return emptyState;
  const drop = {...state, dropped: state.dropped + 1};
  if (e.type === 'turn') return {...state, gen: e.gen ?? state.gen + 1, stopped: false};
  if (e.type === 'stop') {
    // A stop for an older turn is a late echo; a second stop for this turn changes nothing.
    if (e.gen < state.gen || (e.gen === state.gen && state.stopped)) return drop;
    const at = timeOf(e.at);
    return {...state, gen: e.gen, stopped: true, calls: state.calls.map(c => isTerminal(c.status) ? c : {...c, status: 'cancelled', endedAt: at})};
  }
  const gen = e.gen ?? state.gen;
  if (gen < state.gen || (gen === state.gen && state.stopped)) return drop;
  // A newer generation opens its turn.
  if (gen > state.gen) state = {...state, gen, stopped: false};
  const i = state.calls.findIndex(c => c.id === e.id);

  if (i === -1) {
    // A result, ask or reply with no call yet: keep it as an orphan, never drop it.
    const orphan = e.type === 'result' || e.type === 'ask' || e.type === 'reply' || e.type === 'progress';
    const seed = {id: e.id, tool: ('tool' in e && e.tool) || 'unknown', status: 'pending', seq: e.seq, orphan, receivedAt: timeOf(e.at)};
    return {...state, calls: [...state.calls, {...transition(seed, e), seq: e.seq}]};
  }

  const call = state.calls[i];
  const replace = (next) => ({...state, calls: state.calls.map((c, j) => (j === i ? next : c))});

  // A late call or start for an orphan fills in what the orphan lacked, without reopening it.
  if (call.orphan && (e.type === 'call' || e.type === 'start')) {
    const filled = {...call, tool: call.tool === 'unknown' ? (e.tool ?? call.tool) : call.tool, input: call.input ?? e.input, orphan: false};
    return replace(isTerminal(call.status) || e.seq <= call.seq ? filled : {...transition(filled, e), seq: e.seq});
  }
  if (e.seq <= call.seq) return drop;
  if (isTerminal(call.status)) return drop;
  return replace({...transition(call, e), seq: e.seq});
}

/** The lifecycle as a hook: `[state, dispatch]`. */
function useToolCalls(initial = []) {
  return useReducer(toolCallsReducer, {...emptyState, calls: initial});
}

const registry = new Map();
const aliases = new Map();

/** Adds or replaces a renderer, with alias names that resolve to it. */
function registerTool(name, renderer, alias = []) {
  registry.set(name, renderer);
  for (const a of alias) aliases.set(a, name);
}

const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
const firstOf = (input, keys) => keys.map(k => str(input[k])).find(Boolean);
const useful = ['filePath', 'path', 'file', 'url', 'query', 'pattern', 'command', 'description', 'name', 'id'];
const basename = (p) => p?.split('/').filter(Boolean).at(-1) ?? p;

/** The generic renderer for an unknown tool: its name, the first useful argument, up to 3 scalars. */
function genericRenderer(name) {
  return {
    active: `Calling ${name}`, done: `Called ${name}`, ask: `Call ${name}`, noun: name, confirm: `Allow ${name}?`, lines: 8, detailMono: false,
    summary: {key: `tool:${name}`, one: `called ${name}`, many: n => `called ${name} ${n} times`},
    detail: input => firstOf(input, useful),
    body: (call, ctx) => {
      // What the row's detail already says is not repeated.
      const said = firstOf(call.input ?? {}, useful);
      const scalars = Object.entries(call.input ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v) !== said).slice(0, 3);
      const out = call.output ?? str(call.metadata?.output);
      if (!scalars.length && !out) return null;
      return <div className="flex min-w-0 flex-col gap-2">
        {scalars.length > 0 && <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 type-code-sm">
          {scalars.map(([k, v]) => <div key={k} className="contents"><dt className="text-text-2">{k}</dt><dd className="truncate text-text-1">{String(v)}</dd></div>)}
        </dl>}
        {out && <CappedOutput text={out} lines={8} labels={ctx.labels}/>}
      </div>;
    },
  };
}

/** The renderer for a tool name, through aliases, falling back to the generic one. */
function resolveTool(name) {
  const key = aliases.get(name) ?? name;
  return registry.get(key) ?? genericRenderer(name);
}

// ANSI escapes (colours, cursor moves) never reach the screen. A lone \r is a carriage return: the text after it
// overwrites the line from its start, so a progress bar reads as its last frame.
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const cleanOutput = (text) => text.replace(ansi, '').replace(/\r\n/g, '\n').split('\n')
  .map(line => line.split('\r').reduce((shown, part) => part + shown.slice(part.length), ''))
  .join('\n');

const contextRenderer = (active, done, ask, noun, key, one, many, keys) => ({
  active,
  done,
  ask,
  noun,
  confirm: `Allow ${noun}?`,
  lines: 8,
  detailMono: true,
  summary: {key, one, many},

  detail: input => {
    const v = firstOf(input, keys);
    return keys[0] === 'filePath' ? basename(v) : v;
  },

  body: (call, ctx) => {
    const out = call.output ?? str(call.metadata?.output);
    return out ? <CappedOutput text={out} lines={8} labels={ctx.labels}/> : null;
  }
});

registerTool('read', contextRenderer('Reading', 'Read', 'Read', 'read', 'read', 'read a file', n => `read ${n} files`, ['filePath', 'path', 'file']));
registerTool('glob', contextRenderer('Finding files', 'Found files', 'Find files', 'search', 'search', 'searched once', n => `searched ${n} times`, ['pattern']));
registerTool('grep', contextRenderer('Searching', 'Searched', 'Search', 'search', 'search', 'searched once', n => `searched ${n} times`, ['pattern', 'query']));
registerTool('list', contextRenderer('Listing', 'Listed', 'List', 'list', 'list', 'listed a folder', n => `listed ${n} folders`, ['path']), ['ls']);

/** A command as a shell shows it: a quiet $ that copy and selection skip, then the command. */
function Command({
  children
}) {
  return <code><span aria-hidden className="text-text-3 select-none">$ </span>{children}</code>;
}

registerTool('shell', {
  active: 'Running', done: 'Ran', ask: 'Run', noun: 'command', confirm: 'Run this command?', lines: 24, detailMono: true,
  summary: {key: 'shell', one: 'ran a command', many: n => `ran ${n} commands`},
  // The command, not the description: descriptions are imperative ("Run the tests") and read badly after "Ran".
  detail: input => str(input.command) ?? str(input.description),
  body: (call, ctx) => {
    const command = str(call.input?.command);
    const out = call.output ?? str(call.metadata?.output);
    // The row already says the command, so with no output yet there is nothing to open. A command the row cannot show
    // whole (several lines, or longer than a line) is kept in the body with the output.
    if (!out) return null;
    const whole = !!command && (command.includes('\n') || command.length > 80);
    return <div className="flex min-w-0 flex-col gap-1">
      {whole && <pre dir="ltr" className="overflow-x-auto text-start type-code-sm text-text-1"><Command>{command}</Command></pre>}
      <CappedOutput text={cleanOutput(out)} lines={24} labels={ctx.labels}/>
    </div>;
  },
}, ['bash', 'sh', 'zsh', 'run_command', 'terminal']);

registerTool('edit', {
  active: 'Editing', done: 'Edited', ask: 'Edit', noun: 'edit', confirm: 'Apply this edit?', lines: 8, detailMono: true,
  summary: {key: 'edit', one: 'edited a file', many: n => `edited ${n} files`},
  detail: input => basename(firstOf(input, ['filePath', 'path', 'file'])),
  body: (call, ctx) => {
    const patch = str(call.metadata?.diff) ?? str(call.metadata?.patch);
    if (!patch) return null;
    return <PatchPreview patch={patch} lines={8} labels={ctx.labels}/>;
  },
}, ['write', 'apply_patch', 'patch', 'multiedit', 'str_replace']);

registerTool('webfetch', {
  active: 'Fetching', done: 'Fetched', ask: 'Fetch', noun: 'fetch', confirm: 'Fetch this page?', lines: 8, detailMono: true,
  summary: {key: 'web', one: 'fetched a page', many: n => `fetched ${n} pages`},
  detail: input => {
    const url = str(input.url);
    try { return url ? new URL(url).host + new URL(url).pathname.replace(/\/$/, '') : undefined; } catch { return url; }
  },
  body: (call, ctx) => (call.output ? <CappedOutput text={call.output} lines={8} labels={ctx.labels}/> : null),
}, ['fetch', 'web_fetch']);

/** The requests an http or mcp call reports in metadata.requests, newest last. */
const requestsOf = (call) => (Array.isArray(call.metadata?.requests) ? call.metadata.requests : []);

registerTool('http', {
  active: 'Calling', done: 'Called', ask: 'Call', noun: 'request', confirm: 'Send this request?', lines: 10, detailMono: false,
  summary: {key: 'http', one: 'made a request', many: n => `made ${n} requests`},
  // While it runs, the newest target; once done, "42 requests, 2 failed".
  detail: (input, call) => {
    const requests = requestsOf(call);
    if (requests.length && isTerminal(call.status)) return summarizeRequests(requests);
    return requests.at(-1)?.target ?? str(input.url) ?? str(input.server) ?? str(input.name);
  },
  detailNode: (_, call) => {
    const requests = requestsOf(call);
    return requests.length && isTerminal(call.status) ? <RequestSummary items={requests}/> : undefined;
  },
  body: call => {
    const requests = requestsOf(call);
    return requests.length ? <RequestTicker items={requests} live={call.status === 'running'}/> : null;
  },
}, ['http_request', 'api', 'mcp', 'mcp_call']);

registerTool('websearch', {
  active: 'Searching the web for', done: 'Searched the web for', ask: 'Search the web for', noun: 'search', confirm: 'Search the web?', lines: 8,
  summary: {key: 'websearch', one: 'searched the web', many: n => `searched the web ${n} times`},
  detail: input => str(input.query),
  body: (call, ctx) => (call.output ? <CappedOutput text={call.output} lines={8} labels={ctx.labels}/> : null),
}, ['web_search', 'search_web']);

registerTool('task', {
  active: 'Delegating', done: 'Delegated', ask: 'Delegate', noun: 'task', confirm: 'Delegate this task?', lines: 8,
  summary: {key: 'task', one: 'ran a subagent', many: n => `ran ${n} subagents`},
  detail: (input, call) => {
    const current = str(call.metadata?.current);
    return call.status === 'running' && current ? `↳ ${current}` : str(input.description);
  },
  body: (call, ctx) => (call.output ? <CappedOutput text={call.output} lines={8} labels={ctx.labels}/> : null),
}, ['subagent', 'agent']);

const toolLabels = {
  status: {pending: 'Preparing', running: 'Running', completed: 'Done', error: statusLabels.fail, 'awaiting-permission': statusLabels.waiting, denied: 'Denied', cancelled: 'Stopped'},
  orphaned: 'Orphaned result',
  result: 'Result',
  forCall: id => `for call ${id}`,
  showMore: (count, unit) => `Show ${formatCount(count)} more ${unit === 'lines' ? (count === 1 ? 'line' : 'lines') : 'characters'}`,
  showLess: 'Show less',
  trimmed: characters => `Trimmed at ${formatCount(characters)} characters`,
  added: 'added',
  removed: 'removed',
  worked: time => `Worked for ${time}`,
  ranTools: count => (count === 1 ? 'Ran 1 tool' : `Ran ${count} tools`),
  failedCount: count => (count === 1 ? 'Failed' : `${count} failed`),
  allow: 'Allow',
  deny: 'Deny',
};

/** The default words with a caller's on top; status words merge one by one. */
const wordsFor = (labels) => ({...toolLabels, ...labels, status: {
  ...toolLabels.status,
  ...labels?.status
}});

// ---------- Output ----------

/**
 * Output cut at `lines` and at `lines` x 120 characters while collapsed, and at `chars` in all, with the cut said in
 * words and a button for the rest. One 250,000-character line opens as 1,200 characters, not as a wall. Shown in full,
 * it scrolls inside a box 384px tall.
 */
function CappedOutput({
  text,
  lines,
  chars = 20_000,
  labels
}) {
  const words = wordsFor(labels);
  const [all, setAll] = useState(false);
  const trimmed = text.length > chars;
  const body = (trimmed ? text.slice(0, chars) : text).replace(/\n+$/, '');
  const rows = body.split('\n');
  const hiddenLines = Math.max(0, rows.length - lines);
  const byLines = hiddenLines ? rows.slice(0, lines).join('\n') : body;
  const limit = lines * CHARS_PER_LINE;
  const hiddenChars = Math.max(0, byLines.length - limit);
  const shown = all ? body : hiddenChars ? `${byLines.slice(0, limit)}…` : byLines;
  const more = hiddenLines > 0 || hiddenChars > 0;
  return <div data-slot="tool-call-output" className="flex min-w-0 flex-col gap-1">
    <pre dir="ltr" data-all={all || undefined} className="min-w-0 overflow-x-auto text-start type-code-sm whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere] data-all:max-h-96 data-all:overflow-y-auto"><code>{shown}</code></pre>
    {trimmed && <p className="type-caption text-text-2 data">{words.trimmed(chars)}</p>}
    {more && <ShowMoreRow data-slot="tool-call-more" onClick={() => setAll(v => !v)}>{all ? words.showLess : hiddenLines > 0 ? words.showMore(hiddenLines, 'lines') : words.showMore(hiddenChars, 'characters')}</ShowMoreRow>}
  </div>;
}

/** "+12 −3": the lines a patch added and removed, with the words a screen reader hears instead of the signs. */
function DiffCount({
  added,
  removed,
  addedLabel = 'added',
  removedLabel = 'removed',
  className
}) {
  return <span data-slot="diff-count" dir="ltr" className={cn('data', className)}><span aria-hidden>+</span>{added}<span className="sr-only"> {addedLabel}</span> <span aria-hidden>−</span>{removed}<span className="sr-only"> {removedLabel}</span></span>;
}

/** The first lines of a unified patch, signed, with counts. */
function PatchPreview({
  patch,
  lines,
  labels
}) {
  const words = wordsFor(labels);
  const changed = patch.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const added = changed.filter(l => l.startsWith('+')).length;
  const removed = changed.length - added;
  return <div className="flex min-w-0 flex-col gap-1">
    <p className="text-start type-caption text-text-2"><DiffCount added={added} removed={removed} addedLabel={words.added} removedLabel={words.removed}/></p>
    <CappedOutput text={changed.map(l => (l[0] === '-' ? '−' : '+') + ' ' + l.slice(1)).join('\n')} lines={lines} labels={labels}/>
  </div>;
}

// ---------- Labels and timing ----------

/** The row's label and detail for a call in its current state. `labels` names an orphan that never named its tool. */
function toolLabel(call, labels) {
  const r = resolveTool(call.tool);
  const detail = (call.input && r.detail?.(call.input, call)) ?? call.title;
  // An orphan whose call never named its tool: say what it is, a result, and whose.
  if (call.orphan && call.tool === 'unknown') return {text: labels?.result ?? toolLabels.result, detail: call.title ?? (labels?.forCall ?? toolLabels.forCall)(call.id)};
  switch (call.status) {
    case 'pending': return {text: `Preparing ${r.noun}`, detail: call.input ? detail : undefined};
    case 'running': return {text: r.active, detail};
    case 'completed': return {text: r.done, detail};
    // Failed and stopped calls take the imperative too: "Fetch docs" beside "Failed", never "Fetching".
    default: return {text: r.ask, detail};
  }
}

/** How long a call took, as a clock reads (420ms, 1.2s, 2m 04s). */
const formatDuration = formatElapsed;

/**
 * Moves focus to the row when Allow and Deny are replaced by it. Without it the pressed button leaves the page and
 * focus falls to the body, so a keyboard or screen reader user starts again from the top.
 */
function useFocusWhenReplaced(replaced) {
  const region = useRef(null);
  const target = useRef(null);
  const was = useRef(replaced);
  useEffect(() => {
    const before = was.current;
    was.current = replaced;
    if (before || !replaced) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || region.current?.contains(active)) target.current?.focus();
  }, [replaced]);
  return {region, target};
}

function ToolCall({
  call,
  size = 'default',
  onReply,
  actions,
  label,
  doneLabel,
  detail: detailProp,
  detailMono,
  duration,
  children,
  open,
  defaultOpen,
  onOpenChange,
  labels,
  className,
  ref,
  ...allProps
}) {
  const words = wordsFor(labels);
  const {force, rest: props} = splitForce(allProps);
  const r = resolveTool(call.tool);
  const running = call.status === 'running';
  const pending = call.status === 'pending';
  const asking = call.status === 'awaiting-permission';
  const denied = call.status === 'denied';
  const failed = call.status === 'error';
  const ms = running || pending ? undefined : duration ?? (call.startedAt !== undefined && call.endedAt !== undefined ? Math.max(0, call.endedAt - call.startedAt) : undefined);
  const base = toolLabel(call, words);
  const text = label === undefined ? base.text : call.status === 'completed' ? (doneLabel ?? pastTense(label)) : label;
  const detail = detailProp ?? base.detail;
  // A renderer may draw its own detail, but never over a caller's, an orphan's or a call still without input.
  const detailShown = detailProp ?? (!call.orphan && call.input ? r.detailNode?.(call.input, call) : undefined) ?? detail;
  const mono = detailMono ?? (call.orphan && call.tool === 'unknown' ? false : !!r.detailMono);
  const orphaned = !!call.orphan && isTerminal(call.status);
  const word = orphaned ? words.orphaned : words.status[call.status];
  // Allow and Deny leave with the waiting state, taking focus with them. The row takes it instead.
  const {region, target} = useFocusWhenReplaced(!asking);
  const rootRef = useMemo(() => mergeRefs(region, ref), [region, ref]);
  const rowRef = useCallback((el) => { target.current = el; }, [target]);
  const titleId = useId();

  // A failed call opens on its message, the moment it fails, so trouble is never one click away.
  const [openState, setOpenState] = useState(defaultOpen ?? failed);
  useEffect(() => { if (failed) setOpenState(true); }, [failed]);

  const shared = {
    'data-slot': 'tool-call',
    'data-status': call.status,
    'data-tool': call.tool,
    'data-size': size,
    'data-orphan': call.orphan || undefined,
    // The thread's jump goes to the call waiting on the person.
    'data-waiting': asking || undefined,
    'aria-busy': running || pending || undefined,
  };
  const rootClass = cn('group/tool-call relative flex w-full min-w-0 flex-col text-text-1', className);

  // Waiting: the row is a card of its own, a decision. The question is the title in the panel, one sentence and the
  // detail in full under it, Deny and Allow on the shell's footer row.
  if (asking) {
    const command = str(call.input?.command);
    const patterns = call.permission?.patterns.join('\n');
    const full = command ?? patterns ?? (call.input && firstOf(call.input, useful)) ?? detail;
    const question = typeof r.confirm === 'function' ? r.confirm(call.input ?? {}, call) : r.confirm ?? `${r.ask} this ${r.noun}?`;
    const footer = onReply
      ? <CardFooter data-slot="tool-call-actions">
          <Button size="sm" variant="secondary" onClick={() => onReply('reject')}>{words.deny}</Button>
          <Button size="sm" variant="confirm" onClick={() => onReply('once')}>{words.allow}</Button>
        </CardFooter>
      : actions ? <CardFooter data-slot="tool-call-actions">{actions}</CardFooter> : null;
    return <div {...shared} {...props} ref={rootRef} className={cn(rootClass, 'my-1')}>
      <Card data-slot="tool-call-approval" role="group" aria-labelledby={titleId}>
        <CardHeader><CardTitle id={titleId} data-slot="tool-call-title">{question}</CardTitle></CardHeader>
        <CardContent className="gap-2">
          {call.permission?.message && <p data-slot="tool-call-request" className="type-body-sm text-text-2">{call.permission.message}</p>}
          {full && (command
            ? <pre dir="ltr" data-slot="tool-call-command" className="well min-w-0 rounded-overlay px-3 py-2 text-start type-code-sm whitespace-pre-wrap text-text-1 [overflow-wrap:anywhere]"><Command>{full}</Command></pre>
            : <p data-slot="tool-call-command" className="well min-w-0 rounded-overlay px-3 py-2 type-body-sm whitespace-pre-wrap text-text-1 [overflow-wrap:anywhere]">{full}</p>)}
        </CardContent>
        {footer}
      </Card>
    </div>;
  }

  const rendered = children ?? r.body?.(call, {size, labels}) ?? null;
  const note = failed && call.error ? <p data-slot="tool-call-error" className="type-body-sm text-text-1 [overflow-wrap:anywhere]">{call.error}</p>
    : denied && call.reason ? <p data-slot="tool-call-reason" className="type-body-sm text-text-2 [overflow-wrap:anywhere]">{call.reason}</p>
      : null;
  const expands = rendered !== null || note !== null;

  // The glyph cell holds the state; the end of the line holds the duration, and trouble and a stop say so in a word.
  const glyph = orphaned || call.status === 'cancelled' || denied ? 'stopped' : running || pending ? 'running' : failed ? 'fail' : 'done';
  const end = orphaned ? <span>{word}</span>
    : running || pending ? <span className="sr-only">{word}</span>
      : failed ? <><span className="text-fail-text">{word}</span>{ms !== undefined && formatDuration(ms)}</>
        : call.status === 'cancelled' ? <span>{word}</span>
          : denied ? null
            : <><span className="sr-only">{word}</span>{ms !== undefined && formatDuration(ms)}</>;

  const row = <>
    <StepGlyph state={glyph}/>
    <span data-slot="tool-call-label" className="shrink-0 text-text-2">{denied ? word : text}</span>
    {/* The target truncates first, down to 48px. On a phone it wraps to a second line instead, so the meaning stays. */}
    <span
      data-slot="tool-call-detail"
      dir={mono ? 'ltr' : undefined}
      title={typeof detail === 'string' ? detail : undefined}
      className={cn('min-w-12 truncate text-start text-text-1 max-sm:overflow-visible max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]', mono && 'mono', !detail && 'min-w-0')}
    >{detailShown}</span>
    <span data-slot="tool-call-end" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-text-2 data empty:hidden">{end}</span>
    <Disclosure open={expands} end/>
  </>;

  if (!expands) {
    return <div {...shared} {...props} ref={rootRef} className={rootClass}>
      {/* tabIndex -1: out of the tab order, but it can take focus when Allow and Deny go. */}
      <div ref={rowRef} tabIndex={-1} data-slot="tool-call-row" className={rowVariants({size, opens: false})} {...force}>
        {row}
      </div>
    </div>;
  }

  return <CollapsiblePrimitive.Root
    {...shared}
    open={open ?? openState}
    onOpenChange={next => { setOpenState(next); onOpenChange?.(next); }}
    {...props}
    ref={rootRef}
    className={rootClass}
  >
    <CollapsiblePrimitive.Trigger ref={rowRef} data-slot="tool-call-row" {...force} className={rowVariants({size})}>
      {row}
    </CollapsiblePrimitive.Trigger>
    {/* The panel cuts: no height tween. The body opens at its natural height, under the verb. */}
    <CollapsiblePrimitive.Panel data-slot="tool-call-content" className="flex min-w-0 flex-col gap-2 ps-6 pt-0.5 pb-2">
      {note}
      {rendered !== null && <div data-slot="tool-call-well" className="flex min-w-0 flex-col gap-3 well rounded-overlay px-3 py-2">{rendered}</div>}
    </CollapsiblePrimitive.Panel>
  </CollapsiblePrimitive.Root>;
}

/**
 * What a turn's list shows. Done, two or more calls fold into one line, keyed `group:done`. Live, the completed calls
 * before the first one that is not completed fold into `group:earlier` when there are two or more, and the rest stay
 * rows. The newest call is never inside a live group, even once it has completed, so the turn always shows its last
 * step. One call is always its own row.
 */
function groupToolCalls(calls, live = false) {
  const rows = list => list.map(call => ({type: 'call', key: call.id, call}));
  if (!live) return calls.length > 1 ? [{type: 'group', key: 'group:done', calls: [...calls], done: true}] : rows(calls);
  const lead = calls.findIndex(c => c.status !== 'completed');
  const n = Math.min(lead === -1 ? calls.length : lead, calls.length - 1);
  return n > 1 ? [{type: 'group', key: 'group:earlier', calls: calls.slice(0, n), done: false}, ...rows(calls.slice(n))] : rows(calls);
}

/** Ms from the first start to the last end, or undefined when the calls carry no times. */
function spanOf(calls) {
  const starts = calls.flatMap(c => c.startedAt ?? []);
  const ends = calls.flatMap(c => c.endedAt ?? []);
  return starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : undefined;
}

/**
 * Calls folded into one line that opens them inline. A finished turn reads "Worked for 14s" (or "Ran 5 tools" with no
 * times) and a failure keeps its coral word at the end; the calls before a live one read as what they did.
 */
function ToolCallGroup({
  calls,
  done = false,
  size = 'default',
  labels,
  ...props
}) {
  const words = wordsFor(labels);
  const span = spanOf(calls);
  const failures = calls.filter(c => c.status === 'error').length;
  const took = calls.reduce((sum, c) => sum + (c.startedAt !== undefined && c.endedAt !== undefined ? Math.max(0, c.endedAt - c.startedAt) : 0), 0);
  const summary = done ? (span ? words.worked(formatDuration(span)) : words.ranTools(calls.length)) : summarizeToolCalls(calls);
  const meta = failures ? <span className="text-fail-text">{words.failedCount(failures)}</span> : !done && took > 0 ? formatDuration(took) : null;
  return <ActivityGroup summary={summary} meta={meta} size={size} {...props}>
    {calls.map(c => <ToolCall key={c.id} call={c} size={size} labels={labels}/>)}
  </ActivityGroup>;
}

/** Hides orphans younger than `ttl` ms, so a result that is only slightly early waits for its call. */
function useOrphanGate(calls, ttl) {
  const [, force] = useState(0);
  const young = calls.filter(c => c.orphan && c.receivedAt !== undefined && Date.now() - c.receivedAt < ttl);
  useEffect(() => {
    if (!young.length) return;
    const next = Math.min(...young.map(c => ttl - (Date.now() - c.receivedAt)));
    const t = setTimeout(() => force(n => n + 1), Math.max(0, next) + 10);
    return () => clearTimeout(t);
  });
  return calls.filter(c => !young.includes(c));
}

/**
 * The calls of a turn as quiet lines, no frame around them. Live, the completed calls before the current one fold into
 * one line and the current call is its own row with the arc; done, everything folds into "Worked for 14s".
 */
function ToolCallList({
  calls,
  live,
  hideCompleted = false,
  orphanTtl = 2000,
  size = 'default',
  onReply,
  actions,
  labels,
  className,
  ...props
}) {
  const ready = useOrphanGate(calls, orphanTtl);
  const visible = hideCompleted ? ready.filter(c => c.status !== 'completed') : ready;
  const active = live ?? visible.some(c => !isTerminal(c.status));
  const items = groupToolCalls(visible, active);
  return <div data-slot="tool-call-list" className={cn('flex min-w-0 flex-col', className)} {...props}>
    {items.map(item => item.type === 'group'
      ? <ToolCallGroup key={item.key} calls={item.calls} done={item.done} size={size} labels={labels}/>
      : <ToolCall key={item.key} call={item.call} size={size} labels={labels} onReply={onReply && (reply => onReply(item.call, reply))} actions={actions?.(item.call)}/>)}
  </div>;
}

// ---------- Summary for Activity ----------

const endOf = (s) => (s === 'completed' ? 'ok' : s === 'error' ? 'fail' : s === 'cancelled' ? 'stopped' : s === 'denied' ? 'denied' : s === 'awaiting-permission' ? 'waiting' : s);

/** "Edited 3 files, ran a command, 1 failed, 1 stopped". Only populated counts show. */
function summarizeToolCalls(calls) {
  const done = new Map();
  let failed = 0, stopped = 0, denied = 0;
  for (const c of calls) {
    if (c.status === 'completed') {
      const r = resolveTool(c.tool);
      const hit = done.get(r.summary.key);
      done.set(r.summary.key, {n: (hit?.n ?? 0) + 1, r});
    } else if (c.status === 'error') failed++;
    else if (c.status === 'cancelled') stopped++;
    else if (c.status === 'denied') denied++;
  }
  return joinSummary(
    [...done.values()].map(({n, r}) => (n === 1 ? r.summary.one : r.summary.many(n))),
    [failed && `${failed} failed`, denied && `${denied} denied`, stopped && `${stopped} stopped`].filter(Boolean),
  );
}

/** Props for an <Activity> over a list of calls: the call it follows, and the summary when done. */
function toolActivity(calls, labels = {}) {
  const items = calls.map(c => ({c, status: endOf(c.status)}));
  const head = pickActivity(items)?.c;
  const active = calls.some(c => c.status === 'pending' || c.status === 'running' || c.status === 'awaiting-permission');
  // The header follows the live (-ing) phrase of its head, whatever state the head is in; the done label is its past
  // tense. A stopped head never shows the imperative "Run" while the header settles.
  const live = head && toolLabel({...head, status: 'running'});
  const label = head ? (head.status === 'awaiting-permission' ? (labels.waiting ?? statusLabels.waiting) : [live.text, live.detail].filter(Boolean).join(' ')) : '';
  // A turn that was stopped ends on the stopped word even when some calls finished first.
  const status = calls.some(c => c.status === 'error') ? 'fail' : calls.some(c => c.status === 'cancelled') ? 'stopped' : 'ok';
  return {label, active, doneLabel: summarizeToolCalls(calls) || pastTense(label), status};
}

export { ToolCall, ToolCallGroup, ToolCallList, CappedOutput, DiffCount, toolCallsReducer, useToolCalls, groupToolCalls, registerTool, resolveTool, summarizeToolCalls, toolActivity, toolLabel, formatDuration, cleanOutput, isTerminal };
