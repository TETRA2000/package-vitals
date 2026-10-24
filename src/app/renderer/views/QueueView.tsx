import type { ViewProps } from './types';

export function QueueView(_props: ViewProps & { repoFilter: number | null; onRepoFilterChange: (repoId: number | null) => void }) {
  return <h2>Queue</h2>;
}
