import { mountRecoveryFixture } from './transcript-read-recovery';

// Inspect only this synthetic state when driving the isolated dev WebView.
(window as any).__transcriptRecoveryFixture = mountRecoveryFixture(document.getElementById('root')!);
