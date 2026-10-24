import type { Overview, VitalsApi } from '../../shared/api.js';

export interface ViewProps {
  api: VitalsApi;
  overview: Overview;
  snapshotId: number;
}
