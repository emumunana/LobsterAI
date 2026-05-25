import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { DraftAttachment } from '../../store/slices/coworkSlice';

export interface MediaLabel {
  attachment: DraftAttachment;
  label: string;
  mediaType: 'image' | 'video' | 'audio';
  index: number;
}

interface MediaMentionPickerProps {
  items: MediaLabel[];
  filter: string;
  position: { top: number; left: number };
  onSelect: (item: MediaLabel) => void;
  onDismiss: () => void;
}

const MediaMentionPicker: React.FC<MediaMentionPickerProps> = ({
  items,
  filter,
  position,
  onSelect,
  onDismiss,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = items.filter(item =>
    item.label.toLowerCase().includes(filter.toLowerCase()) ||
    item.attachment.name.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    }
  }, [filtered, selectedIndex, onSelect, onDismiss]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute z-50 w-56 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      style={{ bottom: position.top, left: position.left }}
    >
      <div className="max-h-40 overflow-y-auto p-1">
        {filtered.map((item, idx) => (
          <button
            key={item.attachment.path}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
              idx === selectedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-background/80'
            }`}
          >
            <span className="shrink-0 rounded bg-primary/20 px-1 py-0.5 text-[10px] font-medium text-primary">
              @{item.label}
            </span>
            <span className="min-w-0 truncate text-secondary">{item.attachment.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default MediaMentionPicker;

/**
 * Compute media labels for a list of attachments.
 * Images → 图片1, 图片2..., Videos → 视频1..., Audio → 音频1...
 */
export function computeMediaLabels(attachments: DraftAttachment[]): MediaLabel[] {
  const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif']);
  const videoExts = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', 'm4v']);
  const audioExts = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma']);

  const getMediaType = (att: DraftAttachment): 'image' | 'video' | 'audio' | null => {
    if (att.isImage) return 'image';
    const ext = att.name.split('.').pop()?.toLowerCase() || '';
    if (imageExts.has(ext)) return 'image';
    if (videoExts.has(ext)) return 'video';
    if (audioExts.has(ext)) return 'audio';
    return null;
  };

  const counters = { image: 0, video: 0, audio: 0 };
  const labelMap = { image: '图片', video: '视频', audio: '音频' };
  const labels: MediaLabel[] = [];

  for (const att of attachments) {
    const type = getMediaType(att);
    if (!type) continue;
    counters[type]++;
    labels.push({
      attachment: att,
      label: `${labelMap[type]}${counters[type]}`,
      mediaType: type,
      index: counters[type],
    });
  }

  return labels;
}
