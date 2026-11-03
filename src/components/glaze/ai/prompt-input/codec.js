import { mentionToText } from '@/components/glaze/ai/mention';

const CODEC_TYPE = 'application/x-glaze-prompt';
const DRAFT_PREFIX = 'glaze:prompt-draft:';
const PASTE_LINES = 3;
const PASTE_CHARS = 150;

const prefix = (type) => (type === 'command' ? '/' : type === 'paste' ? '' : '@');
/** An IME is composing: isComposing, or keyCode 229, which WebKit sends after compositionend. */
const isComposing = (event) => event.nativeEvent.isComposing || event.keyCode === 229;

/** Walks editor DOM into plain text, the serialized form, the codec (pastes collapsed) and the mentions. */
function serialize(root, pastes) {
  let text = '';
  let serialized = '';
  let codec = '';
  const mentions = [];
  const add = (plain, link = plain, raw = link) => { text += plain; serialized += link; codec += raw; };
  const walk = (node) => {
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        add((child.nodeValue ?? '').replace(/ /g, ' ').replace(/​/g, ''));
      } else if (child instanceof HTMLElement) {
        const {mentionId: id, mentionType, mentionLabel: label} = child.dataset;
        if (id !== undefined && mentionType && label !== undefined) {
          const type = mentionType;
          const ref = {id, type, label};
          if (type === 'paste') {
            // A paste is its own block: a line break before it unless one is already there, and one after.
            const body = `${text && !/\n\s*$/.test(text) ? '\n' : ''}${pastes.get(id) ?? ''}\n`;
            add(body, body, mentionToText(ref));
          } else {
            mentions.push(ref);
            add(`${prefix(type)}${label}`, mentionToText(ref));
          }
        } else if (child.tagName === 'BR') {
          add('\n');
        } else if (!child.hasAttribute('data-template')) {
          if ((child.tagName === 'DIV' || child.tagName === 'P') && text && !text.endsWith('\n')) add('\n');
          walk(child);
        }
      }
    });
  };
  walk(root);
  return {text, serialized, codec, mentions};
}

/** Lines as a person counts them: a trailing newline (how copied lines usually end) is not a line. */
const lineCount = (body) => body.replace(/\n$/, '').split('\n').length;

export { serialize, lineCount, isComposing, CODEC_TYPE, DRAFT_PREFIX, PASTE_LINES, PASTE_CHARS };
