// The caret around chips. A chip is one atomic node in the editor, so Backspace, Delete and the arrow keys
// ask what sits right before or after a collapsed caret, skipping the empty text nodes contenteditable leaves.

const ZERO_WIDTH = /​/g;

const isChip = node => node instanceof HTMLElement && !!node.dataset.mentionId;

/** The chip right before (back) or after (forward) a collapsed caret inside `editor`, skipping empty text. */
function chipAtCaret(editor, direction) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const {anchorNode: node, anchorOffset: offset} = selection;
  if (!node || !editor?.contains(node)) return null;
  let sibling = null;
  if (node.nodeType === Node.TEXT_NODE) {
    const data = (node).data;
    if (direction === 'back' && data.slice(0, offset).replace(ZERO_WIDTH, '') !== '') return null;
    if (direction === 'forward' && data.slice(offset).replace(ZERO_WIDTH, '') !== '') return null;
    sibling = direction === 'back' ? node.previousSibling : node.nextSibling;
  } else {
    sibling = direction === 'back' ? node.childNodes[offset - 1] ?? null : node.childNodes[offset] ?? null;
  }
  while (sibling && sibling.nodeType === Node.TEXT_NODE && !(sibling).data.replace(ZERO_WIDTH, '')) {
    sibling = direction === 'back' ? sibling.previousSibling : sibling.nextSibling;
  }
  return isChip(sibling) ? sibling : null;
}

/** Puts a collapsed caret right before or after a node. */
function caretAt(place, node) {
  const range = document.createRange();
  if (place === 'before') range.setStartBefore(node); else range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Puts a collapsed caret at the end of a node's contents. */
function caretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export {isChip, chipAtCaret, caretAt, caretAtEnd};
