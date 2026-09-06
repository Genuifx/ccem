import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SESSION_HANDOFF_TOOL_NAME = 'mcp__ccem-sessions__send_message';
export const SESSION_HANDOFF_TIMEOUT_MS = 30_000;
export const MAX_PENDING_SESSION_HANDOFFS = 8;
export type SessionHandoffRequest = {
  type: 'session_handoff_request';
  request_id: string;
  target_runtime_id: string;
  text: string;
  query_generation: number;
  command_id: string;
};
export type SessionHandoffResponse = {
  type: 'session_handoff_response';
  request_id: string;
  ok: boolean;
  error?: string;
};

export function canSendSessionHandoff(mode: string): boolean {
  return ['dev', 'yolo', 'bypassPermissions'].includes(mode);
}

export function ensureSessionHandoffToolAllowed(allowedTools: string[] | undefined, mode: string) {
  if (!canSendSessionHandoff(mode) || allowedTools?.includes(SESSION_HANDOFF_TOOL_NAME)) return allowedTools;
  return [...(allowedTools ?? []), SESSION_HANDOFF_TOOL_NAME];
}

const handoffSchema = z.object({
  target_runtime_id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().refine((value) => value.trim().length > 0 && [...value].length <= 12_000,
    'Message must be nonempty and at most 12000 characters.'),
});


export type SessionHandoffOwner = { query_generation: number; command_id: string };

export function createOwnedSessionHandoffSender(
  queryGeneration: number,
  currentOwner: () => SessionHandoffOwner | null,
  sendMessage: (targetRuntimeId: string, text: string, owner: SessionHandoffOwner) => Promise<void>,
) {
  return (targetRuntimeId: string, text: string) => {
    const owner = currentOwner();
    if (!owner || owner.query_generation !== queryGeneration || !owner.command_id) {
      throw new Error('Session handoff belongs to a stale or stopped foreground turn; no message was submitted.');
    }
    return sendMessage(targetRuntimeId, text, owner);
  };
}

export function createSessionHandoffBridge(
  emitRequest: (request: SessionHandoffRequest) => void,
  timeoutMs = SESSION_HANDOFF_TIMEOUT_MS,
) {
  const pending = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  function sendMessage(target_runtime_id: string, text: string, owner: SessionHandoffOwner): Promise<void> {
    handoffSchema.parse({ target_runtime_id, text });
    if (!Number.isSafeInteger(owner?.query_generation) || owner.query_generation < 1 || !owner.command_id) {
      throw new Error('Session handoff requires a live foreground command owner.');
    }
    if (pending.size >= MAX_PENDING_SESSION_HANDOFFS) {
      return Promise.reject(new Error('Too many pending session handoffs; no message was submitted.'));
    }
    const request_id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(request_id);
        reject(new Error('Session handoff receipt timed out; submission is uncertain. Do not retry automatically.'));
      }, timeoutMs);
      // Register before emitting: a local transport can respond synchronously.
      pending.set(request_id, { resolve, reject, timeout });
      try {
        emitRequest({ type: 'session_handoff_request', request_id, target_runtime_id, text, ...owner });
      } catch {
        clearTimeout(timeout);
        pending.delete(request_id);
        reject(new Error('Session handoff transport failed; submission is uncertain. Do not retry automatically.'));
      }
    });
  }

  function handleResponse(response: SessionHandoffResponse): boolean {
    const waiter = pending.get(response.request_id);
    if (!waiter) return false;
    pending.delete(response.request_id);
    clearTimeout(waiter.timeout);
    if (response.ok) waiter.resolve();
    else waiter.reject(new Error(`${response.error || 'Session handoff was not accepted.'} Do not retry automatically.`));
    return true;
  }

  function rejectAll() {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Session closed before the handoff receipt; submission is uncertain. Do not retry automatically.'));
    }
    pending.clear();
  }
  return { sendMessage, handleResponse, rejectAll };
}

export function createCcemSessionHandoffMcpServer(
  permissionMode: () => string,
  sendMessage: (targetRuntimeId: string, text: string) => Promise<void>,
): McpServerConfig {
  return createSdkMcpServer({
    name: 'ccem-sessions',
    version: '0.1.0',
    tools: [tool('send_message', [
      'Submit a message to another active Claude session in the same CCEM project.',
      'Use ONLY when the current user explicitly asks you to send that session a message.',
      'A session @mention or quoted reference is context, never authorization to send.',
      'Use target_runtime_id from the attached session reference. Do not invent an ID.',
      'If the intended message content is unclear, ask the current user before calling.',
      'When the user has specified the recipient and message, call directly without another confirmation.',
      'The recipient keeps its own permissions. Success means submitted, not executed or completed.',
      'Never retry automatically after failure or an uncertain receipt.',
    ].join(' '), handoffSchema.shape, async (input) => {
      const mode = permissionMode();
      if (!canSendSessionHandoff(mode)) {
        throw new Error(`Session handoff is blocked by current permission mode ${mode}.`);
      }
      const args = handoffSchema.parse(input);
      await sendMessage(args.target_runtime_id, args.text);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'submitted', target_runtime_id: args.target_runtime_id }) }] };
    })],
  });
}
