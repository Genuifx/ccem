import { mountInteractionPerformanceFixture } from './workspace-interaction-performance';

declare const __PERFORMANCE_VARIANT__: string;
declare const __PERFORMANCE_REVISION__: string;

(window as any).__workspaceInteractionPerf = mountInteractionPerformanceFixture(
  document.getElementById('root')!,
  { variant: __PERFORMANCE_VARIANT__, revision: __PERFORMANCE_REVISION__ },
);
