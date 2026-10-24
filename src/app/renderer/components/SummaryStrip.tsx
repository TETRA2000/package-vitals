import type { QueueCounts } from '../../shared/api.js';

const show = (n: number | null) => (n === null ? '—' : String(n));

export function SummaryStrip({ counts }: { counts: QueueCounts }) {
  return (
    <ul className="summary-strip" aria-label="Summary">
      <li>{`Critical ${show(counts.critical)}`}</li>
      <li>{`Not triaged ${show(counts.notTriaged)}`}</li>
      <li>{`Dev-only ${show(counts.devOnly)}`}</li>
      <li>{`Reachable ${show(counts.reachable)}`}</li>
      <li>{`Uncertain ${show(counts.uncertain)}`}</li>
    </ul>
  );
}
