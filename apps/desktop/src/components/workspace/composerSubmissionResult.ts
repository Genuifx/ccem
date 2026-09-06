export type ComposerSubmitResult = boolean | void | 'delivery_uncertain';
export const COMPOSER_DELIVERY_UNCERTAIN_TOAST_ID = 'composer-delivery-uncertain';

/** Only errors emitted before native input/attention admission are retryable. */
export function nativeComposerFailureResult(error: unknown): false | 'delivery_uncertain' {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // native_runtime.rs: send_user_message rejects enqueue before dispatch;
  // respond_to_prompt rejects stale attention/settings before its reply write.
  const definiteRejectionPrefixes = [
    'Failed to queue native input:',
    'INTERACTIVE_ATTENTION_STALE:',
    'PLAN_SETTINGS_NOT_APPLIED:',
    'PLAN_SETTINGS_ACK_TIMEOUT:',
  ];
  return definiteRejectionPrefixes.some(prefix => message.startsWith(prefix))
    ? false : 'delivery_uncertain';
}
