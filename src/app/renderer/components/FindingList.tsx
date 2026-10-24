import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { FindingRow } from '../../../core/types.js';
import { formatAge } from '../format';

export interface FindingListProps {
  rows: FindingRow[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** The snapshot's finish time: ages are measured at the snapshot. */
  now: string;
}

export function FindingList({ rows, selectedIndex, onSelect, now }: FindingListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 10,
    initialRect: { width: 1000, height: 700 },
    // An element with no layout (jsdom, or not yet shown) reports 0x0; keep the initial size instead of collapsing the window to nothing.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        if (rect.width > 0 && rect.height > 0) cb(rect);
      }),
  });

  useEffect(() => {
    if (selectedIndex !== null) virtualizer.scrollToIndex(selectedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the virtualizer instance is stable
  }, [selectedIndex]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = selectedIndex === null ? 0 : selectedIndex + (e.key === 'ArrowDown' ? 1 : -1);
    const clamped = Math.min(Math.max(next, 0), rows.length - 1);
    if (clamped !== selectedIndex) onSelect(clamped);
  }

  return (
    <div ref={scrollRef} className="finding-scroll">
      <div role="listbox" aria-label="Findings" tabIndex={0} onKeyDown={onKeyDown} className="finding-list" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const r = rows[item.index]!;
          return (
            <div
              key={`${r.repoId}/${r.number}`}
              role="option"
              aria-selected={item.index === selectedIndex}
              className="finding-row"
              onClick={() => onSelect(item.index)}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <span className={`severity severity-${r.severity}`}>{r.severity}</span>
              <span>{`${r.packageName} (${r.ecosystem})`}</span>
              <span>{r.fullName}</span>
              <span className="summary">{`${r.ghsaId}: ${r.summary}`}</span>
              <span className="age">{formatAge(r.createdAt, now)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
