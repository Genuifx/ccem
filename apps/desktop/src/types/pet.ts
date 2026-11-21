export type PetNotificationTone = 'running' | 'done' | 'attention' | 'failed' | 'interrupted';

export interface PetNotificationItem {
  id: string;
  runtimeId: string;
  provider: 'claude' | 'codex' | 'agy';
  providerSessionId: string | null;
  title: string;
  message: string;
  status: string;
  statusLabel: string;
  tone: PetNotificationTone;
  updatedAt: string;
  projectDir: string;
  markReadOnOpen: boolean;
}

export interface PetOpenSessionRequest {
  notificationId: string;
  runtimeId: string;
  providerSessionId?: string | null;
  provider?: string | null;
  status: string;
  markRead: boolean;
}
