import React, { useEffect, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { DraftAttachment } from '../../store/slices/coworkSlice';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { getFileTypeInfo, ImageFileIcon } from '../icons/fileTypes/index';
import XMarkIcon from '../icons/XMarkIcon';

interface AttachmentCardProps {
  attachment: DraftAttachment;
  onRemove: (path: string) => void;
  label?: string;
}

/**
 * Renders a single attachment as a card.
 * - Image attachments: fixed thumbnail with a clear media mention label
 * - Non-image attachments: horizontal card with file-type icon + name + type label
 */
const AttachmentCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  if (attachment.isImage) {
    return <ImageCard attachment={attachment} onRemove={onRemove} label={label} />;
  }
  return <FileCard attachment={attachment} onRemove={onRemove} label={label} />;
};

// ── Image thumbnail card ──────────────────────────────────────────

const ImageCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(attachment.dataUrl ?? null);
  const [imgError, setImgError] = useState(false);
  const [loading, setLoading] = useState(!attachment.dataUrl);

  // If no dataUrl, try loading via IPC
  useEffect(() => {
    if (attachment.dataUrl) {
      setThumbUrl(attachment.dataUrl);
      setLoading(false);
      return;
    }
    if (!attachment.path || attachment.path.startsWith('inline:')) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electron.dialog.readFileAsDataUrl(attachment.path);
        if (!cancelled && result.success && result.dataUrl) {
          setThumbUrl(result.dataUrl);
        }
      } catch {
        // ignore – will show fallback icon
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment.dataUrl, attachment.path]);

  const showFallback = imgError || (!thumbUrl && !loading);

  return (
    <div
      className="group relative h-[72px] w-[72px] flex-shrink-0"
      title={attachment.path}
    >
      {/* Thumbnail or fallback */}
      {loading ? (
        <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-background shadow-subtle">
          <ImageFileIcon className="h-6 w-6 text-blue-400 animate-pulse" />
        </div>
      ) : showFallback ? (
        <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-background shadow-subtle">
          <ImageFileIcon className="h-6 w-6 text-blue-400" />
        </div>
      ) : (
        <img
          src={thumbUrl!}
          alt={attachment.name}
          className="h-full w-full rounded-md border border-border object-cover shadow-subtle"
          onError={() => setImgError(true)}
          draggable={false}
        />
      )}

      {/* Media label badge — bottom */}
      {label && (
        <div className="absolute inset-x-0 bottom-0 flex h-5 items-center justify-center border-t border-white/45 bg-neutral-300/60 px-1.5 backdrop-blur-md">
          <span className="text-[10px] font-semibold leading-none text-white drop-shadow-sm">{label}</span>
        </div>
      )}

      {/* Delete button — top-right, visible on hover */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 group-hover:flex"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

// ── Non-image file card ───────────────────────────────────────────

const FileCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  const { label: typeLabel } = getFileTypeInfo(attachment.name);

  return (
    <div
      className="group relative flex h-16 w-40 flex-shrink-0 items-center gap-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-2"
      title={attachment.path}
    >
      {/* File type icon */}
      <FileTypeIcon fileName={attachment.name} className="h-8 w-8 flex-shrink-0" />

      {/* File name + type label */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-xs font-medium dark:text-claude-darkText text-claude-text">
          {label ? `${label} · ${attachment.name}` : attachment.name}
        </span>
        <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {typeLabel}
        </span>
      </div>

      {/* Delete button — top-right, visible on hover */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute top-1 right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

export default AttachmentCard;
