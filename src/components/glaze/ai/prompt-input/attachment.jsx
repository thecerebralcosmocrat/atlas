'use client';;
import * as React from 'react';
import {Icon, Close, Retry} from '@/components/glaze/icon';
import {cn} from '@/lib/glaze/utils';
import {
  Attachment as AttachmentChip, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGlyph, AttachmentMedia,
  AttachmentProgress, AttachmentTitle, formatBytes,
} from '@/components/glaze/ui/attachment';

const tokensOf = (accept) => (accept ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/** Matches a file against an accept string ("image/*,.log,.md"). No accept string takes everything. */
function accepts(file, accept) {
  const tokens = tokensOf(accept);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  return tokens.some(rule => rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? file.type.startsWith(rule.slice(0, -1)) : file.type === rule);
}

/** During a drag only types are known, not names. An accept with an extension in it is judged at the drop. */
function dragVerdict(accept, items) {
  const tokens = tokensOf(accept);
  if (!items || !tokens.length || tokens.some(t => t.startsWith('.'))) return 'accept';
  const files = Array.from(items).filter(item => item.kind === 'file');
  return files.some(item => !item.type || accepts({name: '', type: item.type}, accept)) ? 'accept' : 'reject';
}

/**
 * Files dragged over the composer: `dragging` while a drag that carries files is over it, 'accept' or 'reject' as
 * judged before the drop, and the handlers for its root. A drag that ends outside the window never sends dragleave,
 * so leaving the window resets it.
 */
function useFileDrop(enabled, onFiles, accept) {
  const depth = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => {
    if (!dragging) return;
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('blur', reset); };
  }, [dragging]);
  // Disabled mid-drag, the handlers go and no dragleave arrives, so the drag state resets here.
  React.useEffect(() => {
    if (enabled) return;
    depth.current = 0;
    setDragging(false);
  }, [enabled]);
  const hasFiles = (event) => Array.from(event.dataTransfer.types).includes('Files');
  const dropProps = enabled ? {
    onDragEnter: (event) => { if (!hasFiles(event)) return; event.preventDefault(); depth.current += 1; setDragging(dragVerdict(accept, event.dataTransfer.items)); },
    onDragOver: (event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = dragging === 'reject' ? 'none' : 'copy'; },
    onDragLeave: (event) => { if (!hasFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
    onDrop: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFiles(Array.from(event.dataTransfer.files));
    },
  } : {};
  return {dragging: enabled && dragging, dropProps};
}

const attachmentLabels = {
  uploading: percent => `Uploading ${percent}%`,
  uploadFailed: 'Upload failed',
  attached: 'Attached',
  retryFile: name => `Retry ${name}`,
  cancelUpload: name => `Cancel upload of ${name}`,
  removeFile: name => `Remove ${name}`,
};

/** One file in the composer: the Attachment chip with its glyph, name, then its size, its progress, or its failure with Retry. */
function PromptAttachment({
  attachment,
  onRemove,
  onRetry,
  labels,
  className,
  ...props
}) {
  const words = {...attachmentLabels, ...labels};
  const {name, size, progress = 0, status, error} = attachment;
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * 100);
  return <AttachmentChip
    data-slot="prompt-attachment"
    state={status}
    title={name}
    className={cn('max-w-64', className)}
    {...props}
  >
    <AttachmentMedia><AttachmentGlyph type="" name={name}/></AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>{name}</AttachmentTitle>
      <AttachmentDescription>
        {status === 'uploading' ? words.uploading(percent) : status === 'error' ? (error ?? words.uploadFailed) : size !== undefined ? formatBytes(size) : words.attached}
      </AttachmentDescription>
    </AttachmentContent>
    {(onRemove || (status === 'error' && onRetry)) && <AttachmentActions>
      {status === 'error' && onRetry && <AttachmentAction aria-label={words.retryFile(name)} onClick={onRetry}><Icon icon={Retry} size={12}/></AttachmentAction>}
      {onRemove && <AttachmentAction aria-label={status === 'uploading' ? words.cancelUpload(name) : words.removeFile(name)} onClick={onRemove}><Icon icon={Close} size={12}/></AttachmentAction>}
    </AttachmentActions>}
    {status === 'uploading' && <AttachmentProgress value={percent} label={name} aria-hidden/>}
  </AttachmentChip>;
}

export { PromptAttachment, accepts, dragVerdict, useFileDrop };
