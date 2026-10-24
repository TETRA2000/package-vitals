import type { VitalsApi } from '../shared/api.js';

declare global {
  interface Window {
    vitals: VitalsApi;
  }
}
