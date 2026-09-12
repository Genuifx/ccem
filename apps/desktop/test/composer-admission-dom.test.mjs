import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build, stop: stopEsbuild } = require('esbuild');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
import { pathToFileURL, fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let importedHarnessPromise;

test.after(async () => {
  if (importedHarnessPromise) {
    const importedHarness = await importedHarnessPromise;
    await fs.rm(importedHarness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

const stubsPlugin = {
  name: 'ccem-composer-submit-reentry-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/webcontentRecovery$/ }, () => ({ path: 'recovery-stub', namespace: 'composer-submit-stubs' }));
    builder.onLoad({ filter: /^recovery-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js', contents: 'export const isRecoveringWebcontent = () => Boolean(globalThis.window?.__ccemRecoveryTest);',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: 'tauri-core-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^tauri-core-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: 'export async function invoke(command, args) { return globalThis.__acceptanceInvoke ? globalThis.__acceptanceInvoke(command, args) : []; }',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({
      path: 'tauri-window-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^tauri-window-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function getCurrentWindow() {
          return { async onDragDropEvent() { return () => {}; } };
        }
      `,
    }));
    builder.onResolve({ filter: /^sonner$/ }, () => ({
      path: 'sonner-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^sonner-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: 'export const toast = { error(message, options) { globalThis.__acceptanceToasts?.push({ kind: "error", message, options }); }, success() {}, warning(message, options) { globalThis.__acceptanceToasts?.push({ kind: "warning", message, options }); } };',
    }));
    builder.onResolve({ filter: /^\.\/composerRouteDraft$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'composer-route-draft-stub', namespace: 'composer-submit-stubs' };
    });
    builder.onLoad({ filter: /^composer-route-draft-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function isRouteDraftPillVisible() { return false; }
        export function isRouteDraftRowVisible() { return false; }
        export function toggleComposerRouteDraft() { return { optIn: true, profileId: null }; }
      `,
    }));
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsap-motion-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^gsap-motion-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export const ccemMotion = {
          duration: { quick: 0, base: 0 },
          ease: { standard: 'none' },
        };
        export function clearMotionProps() {}
        export const gsap = {
          fromTo() {},
          set() {},
          utils: { toArray() { return []; } },
        };
        export function shouldReduceMotion() { return true; }
        export function useGSAP() {}
      `,
    }));
    builder.onResolve({ filter: /^@\/locales$/ }, () => ({
      path: 'locale-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^locale-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useLocale() {
          return { t(key) { return key; }, lang: 'zh' };
        }
      `,
    }));
    builder.onResolve({ filter: /^\.\/WorkspaceRouter$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'workspace-router-stub', namespace: 'composer-submit-stubs' };
    });
    builder.onLoad({ filter: /^workspace-router-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'jsx',
      contents: `
        export function WorkspaceRoutePill() { return null; }
        export function ComposerRouteDraftRow() { return null; }
        export function ComposerRouteDraftPill() { return null; }
      `,
    }));
  },
};

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveDesktopSource(args.path),
    }));
  },
};

async function importHarness() {
  const nativeSource = await fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceNativeSessionView.tsx'), 'utf8');
  const ast = ts.createSourceFile('view.tsx', nativeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let sendCallback = '';
  let stopCallback = '';
  let interactiveCallback = '';
  let sendGuard = '';
  let promptQuickRepliesSource = '';
  let syntheticPlanPredicateSource = '';
  const nativeExpressions = {};
  const primaryProps = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'promptQuickReplies') promptQuickRepliesSource = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'isSyntheticPlanExitPrompt') syntheticPlanPredicateSource = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleSend') {
      sendCallback = node.initializer.arguments[0].getText(ast);
      sendGuard = node.initializer.arguments[0].body.statements[0].expression.getText(ast);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'sendInteractivePromptReply') {
      interactiveCallback = node.initializer.arguments[0].getText(ast);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleStop') {
      stopCallback = node.initializer.arguments[0].getText(ast);
    }
    if (ts.isVariableDeclaration(node) && ['canSend', 'canStopForeground', 'isProcessingTurn'].includes(node.name.getText(ast))) {
      nativeExpressions[node.name.getText(ast)] = node.initializer.getText(ast);
    }
    if (ts.isJsxAttribute(node) && ['primaryActionLabel', 'primaryActionDisabled', 'onPrimaryAction'].includes(node.name.getText(ast))) {
      primaryProps[node.name.getText(ast)] = node.initializer.expression.getText(ast);
    }
    if (ts.isJsxExpression(node) && node.expression?.getText(ast).startsWith("hasComposerInput && session.provider !== 'claude' && canStopForeground")) {
      primaryProps.secondaryStop = node.expression.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(sendCallback, 'actual handleSend callback loaded');
  const workspaceSource = await fs.readFile(path.join(desktopDir, 'src/pages/Workspace.tsx'), 'utf8');
  const workspaceAst = ts.createSourceFile('workspace.tsx', workspaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const launchCallbacks = {};
  function visitWorkspace(node) {
    if (ts.isVariableDeclaration(node) && ['runCreateNativeConversation', 'runContinueHistorySession'].includes(node.name.getText(workspaceAst))) {
      launchCallbacks[node.name.getText(workspaceAst)] = node.initializer.arguments[0].getText(workspaceAst);
    }
    ts.forEachChild(node, visitWorkspace);
  }
  visitWorkspace(workspaceAst);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-submit-reentry-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { getPlanExitPrimaryReply, isPlanExitApprovalText } from '@/components/workspace/workspaceNativeAttention';
        ${promptQuickRepliesSource}
        ${syntheticPlanPredicateSource}
        import { isWorkspaceCronCommand, buildWorkspaceCronAgentPrompt } from '@/components/workspace/workspaceCronCommand';
        import { selectNativeSessionProcessing } from '@/components/workspace/workspaceNativeSessionProjection';
        import { shouldTreatNativeSessionAsProcessing } from '@/components/workspace/workspaceEventTranscript';
        import { useWorkspaceAnnotations } from '@/components/workspace/useWorkspaceAnnotations';
        import { isRecoveringWebcontent as documentIsRecoveringWebcontent } from '@/lib/webcontentRecovery';
        import { Button } from '@/components/ui/button';
        const ProcessingActionIcon = () => <span>stop</span>;
        import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
        import { COMPOSER_DELIVERY_UNCERTAIN_TOAST_ID, nativeComposerFailureResult } from '@/components/workspace/composerSubmissionResult';
        import { readRecoveryDraft, writeRecoveryDraft, recoveryDraftDiagnostics } from '@/lib/recoveryDrafts';
        export const seedRecovery = writeRecoveryDraft;
        export const recoveryCounts = recoveryDraftDiagnostics;
        export const recoveryDraft = key => readRecoveryDraft(key, true);
        export const classifyNativeFailure = nativeComposerFailureResult;

        export function renderNativeQueuedComposer() {
          return renderToStaticMarkup(
            <WorkspaceSessionComposer
              value=""
              onValueChange={() => {}}
              onSubmit={() => {}}
              placeholder="composer input"
              canSubmit={false}
              submitLabel="send message"
              queuedMessages={[{
                id: 'native-queued-message',
                text: 'wait above composer',
                displayText: 'wait above composer',
                deliveryState: 'pending',
                removable: true,
                flushable: false,
              }]}
              onFlushQueuedMessages={() => {}}
              onRemoveQueuedMessage={() => {}}
              queueCanFlush
            />
          );
        }

        export function renderMixedQueuedComposer() {
          return renderToStaticMarkup(
            <WorkspaceSessionComposer
              value=""
              onValueChange={() => {}}
              onSubmit={() => {}}
              placeholder="composer input"
              canSubmit={false}
              submitLabel="send message"
              queuedMessages={[
                {
                  id: 'native-first',
                  text: 'native first',
                  deliveryState: 'pending',
                  removable: true,
                  flushable: false,
                },
                {
                  id: 'legacy-second',
                  text: 'legacy second',
                },
              ]}
              onFlushQueuedMessages={() => {}}
              onRemoveQueuedMessage={() => {}}
              queueCanFlush
            />
          );
        }


        export function mountProvider(container) {
          const state = { stops: [], sends: 0 };
          function Harness() {
            const [processing, setProcessing] = useState(true);
            const [value, setValue] = useState('');
            const [isStopping, setIsStopping] = useState(false);
            state.setProcessing = next => act(() => setProcessing(next));
            const session = { runtime_id: 'codex-test', provider: 'codex', status: processing ? 'processing' : 'idle', lifecycle: { active_command_id: null } };
            const events = [];
            const isSending = false;
            const composerHasDraft = value.length > 0;
            const hasComposerInput = composerHasDraft;
            const sessionAnnotations = { pendingAnnotations: [] };
            const isTerminalStatus = status => ['completed', 'failed', 'stopped'].includes(status);
            const isProcessingTurn = ${nativeExpressions.isProcessingTurn};
            const canStopForeground = ${nativeExpressions.canStopForeground};
            const canSend = ${nativeExpressions.canSend};
            const shouldGuideModel = false;
            const t = key => key;
            const toast = { error() {} };
            const refreshSummary = async () => {};
            const stopNativeSession = async (...args) => { state.stops.push(args); };
            const handleStop = ${stopCallback};
            const onStartNew = () => {};
            return <WorkspaceSessionComposer value={value} onValueChange={setValue}
              onSubmit={() => { if (${sendGuard}) return false; state.sends++; return true; }} canSubmit={canSend}
              submitLabel="send message" placeholder="provider draft"
              primaryActionLabel={${primaryProps.primaryActionLabel}}
              primaryActionDisabled={${primaryProps.primaryActionDisabled}}
              onPrimaryAction={${primaryProps.onPrimaryAction}} secondaryActions={${primaryProps.secondaryStop}} />;
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          return {
            state,
            async clickSend() { await act(async () => container.querySelector('button[aria-label="workspace.composeSend"]').click()); },
            async stop() { await act(async () => container.querySelector('button[aria-label="workspace.nativeStop"]').click()); },
            typeText(text) { act(() => { const editor = container.querySelector('[contenteditable="true"]'); editor.textContent = text; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); }); },
            async enter() { await act(async () => { container.querySelector('[contenteditable="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await Promise.resolve(); }); },
            unmount() { act(() => root.unmount()); },
          };
        }

        export function mountFailure(container, processing, interactiveKind = null, annotationOverrides = null, route = {}) {
          const state = { calls: 0, reject: null, resolve: null, errors: [], warnings: [], result: null, payloads: [], queueCalls: [], responses: [] };
          function Harness() {
            const [revision, setRevision] = useState(0);
            const [initialValue] = useState(() => route.recoveryKey
              ? readRecoveryDraft(route.recoveryKey, true)?.text ?? '' : 'valuable follow-up draft');
            const annotationModel = useWorkspaceAnnotations('admission-test');
            state.annotations = annotationModel;
            state.addAnnotation = (quote, note, anchor) => act(() => annotationModel.addAnnotation(quote, note, anchor));
            state.restoreTwice = (first, second) => {
              let results;
              act(() => { results = [annotationModel.restoreAnnotations(first), annotationModel.restoreAnnotations(second)]; });
              return results;
            };
            state.removeAnnotation = id => act(() => annotationModel.removeAnnotation(id));
            state.editAnnotation = (id, note) => act(() => annotationModel.updateAnnotation(id, note));
            const isSending = false;
            const composerTextRef = { current: 'valuable follow-up draft' };
            const composerPlanModeEnabled = false;
            const sessionRuntimePermMode = 'dev';
            const session = { runtime_id: 'review-only-runtime', project_dir: '/tmp', provider: 'claude', status: processing ? 'processing' : 'ready', lifecycle: { active_command_id: processing ? 'active-plan-command' : null } };
            const events = [];
            const hasQuickReplyPrompt = Boolean(route.plan || route.synthetic);
            const hasHardBlockingAttention = Boolean(route.hardBlock);
            const hasBlockingAttention = hasQuickReplyPrompt || hasHardBlockingAttention;
            const isProcessingTurn = ${nativeExpressions.isProcessingTurn};
            const isRecoveringWebcontent = () => route.recovered ?? documentIsRecoveringWebcontent();
            const queuedStateRef = { current: {runtimeId: session.runtime_id, messages: []} };
            const queuedFlushLeaseRef = { current: null };
            const pendingPlan = route.plan || route.synthetic ? { toolUseId: 'real-exit-plan-tool', eventSeq: 42, rawName: 'ExitPlanMode', prompt: { prompt_type: 'plan_exit', plan_summary: route.synthetic ? 'Claude is ready to run the next step' : 'Concrete QA plan requiring user review', allowed_prompts: ['继续执行'] } } : null;
            const planExitApprovalPrompt = pendingPlan && !isSyntheticPlanExitPrompt(pendingPlan.prompt) ? pendingPlan : null;
            const waitForPendingEnvironmentUpdate = async () => true;
            const makePersistableGuidanceMessage = x => x;
            const parseWorkspacePromptAnnotations = x => x;
            const collectQueuedPromptAnnotations = () => route.queueAnnotationsBlocked ? null : [];
            const flushQueuedMessages = async () => true;
            const clearComposerDraft = () => setRevision(r => r + 1);
            const setComposerPlanModeEnabled = () => {};
            const toast = { error: error => state.errors.push(error), warning: (message, options) => state.warnings.push({ message, options }) };
            const t = x => x;
            class PromptAnnotationLimitError extends Error {}
            const sendPromptBatch = (prompts, options) => {
              state.queueCalls.push({ prompts, options });
              state.calls++;
              state.payloads.push(prompts[0]);
              return new Promise((resolve, reject) => { state.reject = reject; state.resolve = resolve; });
            };
            const buildComposerPromptText = text => text;
            const buildComposerPromptPreview = text => text;
            const extractComposerImagePayloads = attachments => attachments.filter(a => a.kind === 'image');
            const latestEventSeq = () => 1;
            const latestEventsRef = { current: [] };
            const hasPlanExitPrompt = true;
            const sessionDisplayPermMode = 'dev';
            const setIsSending = () => {};
            const setSessionRuntimePermMode = () => {};
            const setLocalUserPrompts = updater => { state.optimistic = updater(state.optimistic ?? []); };
            const sendNativeSessionInput = (_, text) => sendPromptBatch([{ text }]);
            const respondNativeSessionPrompt = (runtimeId, payload) => {
              state.responses.push({ runtimeId, payload });
              state.calls++;
              state.payloads.push(payload);
              return new Promise((resolve, reject) => { state.reject = reject; state.resolve = resolve; });
            };
            const pollEvents = async () => { if (state.refreshFails) throw new Error('REFRESH_FAILED_AFTER_ADMISSION'); };
            const refreshSummary = pollEvents;
            const sendInteractivePromptReply = ${interactiveCallback};
            const handleSend = ${sendCallback};
            const isCreatingNativeSession = false;
            const isResumingHistorySession = false;
            const composePromptRef = { current: initialValue };
            const historyComposerTextRef = composePromptRef;
            const effectiveComposeDir = route.noWorkingDir ? null : '/tmp';
            const composeRouteDraftRef = { current: { optIn: false } };
            const historyRouteDraftRef = composeRouteDraftRef;
            const composeProvider = 'claude';
            const currentEnv = 'fixture';
            const historyEnv = currentEnv;
            const permissionMode = 'dev';
            const historyPermMode = permissionMode;
            const composePlanModeEnabled = false;
            const historyPlanModeEnabled = false;
            const composeEffort = 'high';
            const historyEffort = composeEffort;
            const normalizeEffortForProvider = effort => effort;
            const selectedSession = { source: 'claude', project: effectiveComposeDir, id: 'history-fixture' };
            const messages = [];
            const historyRouteResolutionStatusRef = { current: 'resolved' };
            const isHistoryRouteContinuationBlocked = () => false;
            const resolveComposerDispatch = ({prompt}) => ({ prompt, permMode: 'dev', runtimePermMode: 'dev' });
            const setIsCreatingNativeSession = () => {};
            const setIsResumingHistorySession = () => {};
            const preflightCodexModelMigration = () => {};
            const requestCodexModelMigrationDecision = () => {};
            const acknowledgedCodexModelWarningsRef = { current: new Set() };
            const startAfterCodexModelMigrationGate = async ({start}) => {
              if (route.preflightFailure) throw new Error('preflight unavailable before create');
              return { started: true, value: await start(undefined) };
            };
            const createNativeSession = payload => {
              state.calls++; state.payloads.push(payload);
              return new Promise((resolve, reject) => { state.reject = reject; state.resolve = resolve; });
            };
            const runCreateNativeConversation = ${launchCallbacks.runCreateNativeConversation};
            const runContinueHistorySession = ${launchCallbacks.runContinueHistorySession};
            return <WorkspaceSessionComposer
              value={revision === 0 ? initialValue : ''}
              valueRevision={revision}
              recoveryDraftKey={route.recoveryKey}
              onValueChange={() => {}}
              onSubmit={payload => { state.submission = (async () => { state.result = await (route.launch === 'compose' ? runCreateNativeConversation(payload) : route.launch === 'history' ? runContinueHistorySession(payload) : interactiveKind ? sendInteractivePromptReply({ ...payload, kind: interactiveKind, approved: false, toolUseId: 'attention-test', attentionSeq: 1 }) : handleSend(payload)); return state.result; })(); return state.submission; }}
              annotations={annotationOverrides ?? annotationModel.pendingAnnotations}
              onAnnotationsSent={annotationModel.markAllSent}
              onAnnotationsRestore={annotationModel.restoreAnnotations}
              placeholder="composer input"
              canSubmit
              submitLabel="send message"
            />;
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = () => container.querySelector('[contenteditable="true"]');
          return {
            async submit() {
              await act(async () => {
                container.querySelector('button[aria-label="send message"]').click();
                await Promise.resolve(); await Promise.resolve();
              });
            },
            async reject(error) {
              await act(async () => {
                state.reject(error ?? new Error(interactiveKind || route.plan
                  ? 'INTERACTIVE_ATTENTION_STALE: occurrence is no longer current'
                  : 'Failed to queue native input: client_message_id must not be empty'));
                await state.submission;
                await Promise.resolve();
              });
            },
            async resolve(value) {
              await act(async () => { state.resolve(value); await state.submission; await Promise.resolve(); });
            },
            typeText(text) {
              act(() => {
                editor().textContent = text;
                editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              });
            },
            appendText(text) {
              act(() => {
                editor().appendChild(document.createTextNode(text));
                editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              });
            },
            async appendAndSubmitSameTick(text) {
              await act(async () => {
                editor().appendChild(document.createTextNode(text));
                editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                container.querySelector('button[aria-label="send message"]').click();
                await Promise.resolve(); await Promise.resolve();
              });
            },
            async typeAndSubmitSameTick(text) {
              await act(async () => {
                editor().textContent = text;
                editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                container.querySelector('button[aria-label="send message"]').click();
                await Promise.resolve(); await Promise.resolve();
              });
            },
            async pasteText(text) {
              await act(async () => {
                const event = new Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(event, 'clipboardData', { value: {
                  items: [], files: [], getData: kind => kind === 'text/plain' ? text : '',
                } });
                editor().dispatchEvent(event);
              });
            },
            async pasteImage(name) {
              const attachmentCount = () => container.querySelectorAll('button[aria-label="workspace.composerRemoveAttachment"]').length;
              const previousCount = attachmentCount();
              await act(async () => {
                const file = new File(['test image bytes'], name, { type: 'image/png' });
                const event = new Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(event, 'clipboardData', { value: { files: [file], items: [], getData: () => '' } });
                editor().dispatchEvent(event);
              });
              const deadline = Date.now() + 2000;
              while (attachmentCount() <= previousCount) {
                if (Date.now() >= deadline) throw new Error('Pasted image did not become an attachment');
                await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
              }
            },
            removeFirstAttachment() { act(() => container.querySelector('button[aria-label="workspace.composerRemoveAttachment"]').click()); },
            recoverAllSameTick() { act(() => { for (const button of container.querySelectorAll('[data-composer-rejected-draft] button')) button.click(); }); },
            recoverTwiceSameTick() { act(() => { const button = container.querySelector('[data-composer-rejected-draft] button'); button.click(); button.click(); }); },
            recover() { act(() => container.querySelector('[data-composer-rejected-draft] button').click()); },
            click(selector, flushes = 0) {
              return act(async () => {
                container.querySelector(selector).click();
                for (let i = 0; i < flushes; i += 1) await Promise.resolve();
              });
            },
            text() { return editor().textContent; },
            state,
            unmount() { act(() => root.unmount()); },
          };
        }

        export function mount(container) {
          const state = {
            calls: 0,
            pending: [],
          };

          function Harness() {
            const [value, setValue] = useState('same-tick message');
            return (
              <WorkspaceSessionComposer
                value={value}
                onValueChange={setValue}
                onSubmit={() => {
                  state.calls += 1;
                  return new Promise((resolve) => state.pending.push(resolve));
                }}
                placeholder="composer input"
                canSubmit
                submitLabel="send message"
              />
            );
          }

          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = container.querySelector('[contenteditable="true"]');
          const sendButton = container.querySelector('button[aria-label="send message"]');
          if (!editor || !sendButton) throw new Error('composer controls did not mount');

          return {
            submitWithEnterAndClick() {
              act(() => {
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'Enter',
                  code: 'Enter',
                  bubbles: true,
                  cancelable: true,
                }));
                sendButton.click();
              });
            },
            pressEnter() {
              act(() => editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
              })));
            },
            getCallCount() { return state.calls; },
            typeText(text) {
              act(() => {
                editor.textContent = text;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              });
            },
            text() { return editor.textContent; },
            async resolveAll(result) {
              const pending = state.pending.splice(0);
              await act(async () => {
                pending.forEach((resolve) => resolve(result));
                await Promise.resolve();
              });
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [stubsPlugin, aliasPlugin],
    logLevel: 'silent',
    external: ['jsdom'],
  });
  const imported = await import(pathToFileURL(outputPath).href);
  return { ...imported, tempDir };
}

test('native queued prompt renders in the dock before and outside the composer card', async () => {
  const { renderNativeQueuedComposer } = await importHarness();
  const dom = new JSDOM(`<!doctype html><html><body>${renderNativeQueuedComposer()}</body></html>`);
  const queue = dom.window.document.querySelector('[data-ccem-composer-queue]');
  const item = dom.window.document.querySelector(
    '[data-ccem-composer-queued-message="native-queued-message"]',
  );
  const card = dom.window.document.querySelector('[data-composer-shell-card]');

  assert.ok(queue, 'the composer queue dock must render');
  assert.ok(item, 'the native queued prompt must render in the queue dock');
  assert.ok(card, 'the composer card must render');
  assert.equal(card.contains(item), false, 'queued prompt must not be inside the composer card');
  assert.ok(
    queue.compareDocumentPosition(card) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'queue dock must precede the composer card',
  );
  const heading = queue.querySelector('[data-ccem-composer-queue-heading]');
  assert.ok(heading, 'queue heading must render');
  assert.match(heading.textContent, /workspace\.composerGuideModel/);
  assert.match(heading.textContent, /workspace\.composerQueuedWaiting/);
  assert.doesNotMatch(queue.textContent, /workspace\.composerQueuedCount/);
  assert.match(item.textContent, /workspace\.messageQueuedBadge/);
  assert.match(queue.textContent, /workspace\.composerQueuedWaiting/);
  assert.doesNotMatch(queue.textContent, /workspace\.composerQueuedReady/);
  assert.ok(
    item.querySelector('[aria-label="workspace.composerRemoveQueued"]'),
    'pending backend-owned queue rows must expose the safe cancel action',
  );
  assert.equal(
    queue.querySelector('button:not([aria-label="workspace.composerRemoveQueued"])'),
    null,
    'backend-owned queue rows must not expose the legacy flush action',
  );
});

test('mixed native and legacy queues expose no misleading list-wide flush action', async () => {
  const { renderMixedQueuedComposer } = await importHarness();
  const dom = new JSDOM(`<!doctype html><html><body>${renderMixedQueuedComposer()}</body></html>`);
  const queue = dom.window.document.querySelector('[data-ccem-composer-queue]');
  const rows = [...dom.window.document.querySelectorAll('[data-ccem-composer-queued-message]')];

  assert.ok(queue);
  assert.deepEqual(
    rows.map((row) => row.getAttribute('data-ccem-composer-queued-message')),
    ['native-first', 'legacy-second'],
  );
  assert.equal(
    queue.querySelector('button:not([aria-label="workspace.composerRemoveQueued"])'),
    null,
    'mixed queues must not expose a list-wide flush action that only flushes legacy rows',
  );
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const previous = new Map();

  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      };
    }
  }

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('sessionStorage', window.sessionStorage);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  class TestURL extends window.URL { static createObjectURL() { return 'blob:test-image'; } static revokeObjectURL() {} }
  expose('URL', TestURL);

  for (const name of [
    'File',
    'FileReader',
    'Node',
    'NodeFilter',
    'Text',
    'Element',
    'HTMLElement',
    'HTMLBRElement',
    'HTMLAnchorElement',
    'Event',
    'InputEvent',
    'CompositionEvent',
    'KeyboardEvent',
    'MouseEvent',
    'MutationObserver',
    'DOMRect',
    'Range',
  ]) {
    expose(name, window[name]);
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  expose('ResizeObserver', ResizeObserver);
  let nextAnimationFrameHandle = 1;
  const animationFrames = new Map();
  expose('requestAnimationFrame', (callback) => {
    const handle = nextAnimationFrameHandle++;
    animationFrames.set(handle, callback);
    return handle;
  });
  expose('cancelAnimationFrame', (handle) => animationFrames.delete(handle));
  expose('PointerEvent', window.PointerEvent ?? window.MouseEvent);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  expose('matchMedia', window.matchMedia);

  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    },
  };
}

test('Enter plus send click submits once while pending and re-arms after completion', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mount(container);

  mounted.submitWithEnterAndClick();
  const callsWhilePending = mounted.getCallCount();
  await mounted.resolveAll(false);

  mounted.pressEnter();
  const callsAfterCompletion = mounted.getCallCount();
  await mounted.resolveAll(false);
  mounted.unmount();

  assert.equal(callsWhilePending, 1, 'same-tick Enter and click must share one submission');
  assert.equal(callsAfterCompletion, 2, 'the guard must release after the first submission settles');
});

for (const processing of [false, true]) {
  test(`rejected enqueue ${processing ? 'while busy' : 'while idle'} preserves draft`, async (t) => {
    const { container, restore } = installDom();
    t.after(() => restore());
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, processing);
    assert.equal(mounted.text(), 'valuable follow-up draft');
    await mounted.submit();
    assert.equal(mounted.state.calls, 1);
    const beforeReject = mounted.text();
    await mounted.reject();
    const afterReject = mounted.text();
    assert.equal(mounted.state.result, false);
    assert.equal(afterReject, 'valuable follow-up draft');
    console.log(JSON.stringify({reproduction: 'enqueue_rejection_draft', processing, beforeReject, afterReject, returnedSuccess: mounted.state.result}));
    mounted.unmount();
  });
}

test('enqueue ACK preserves the follow-up being composed', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mount(container);
  mounted.submitWithEnterAndClick();
  assert.equal(mounted.getCallCount(), 1);
  mounted.typeText('next unsent guidance');
  const beforeAck = mounted.text();
  assert.equal(beforeAck, 'next unsent guidance');
  await mounted.resolveAll(true);
  const afterAck = mounted.text();
  assert.equal(afterAck, 'next unsent guidance');
  mounted.pressEnter();
  assert.equal(mounted.getCallCount(), 2);
  await mounted.resolveAll(true);
  assert.equal(mounted.text(), '');
  assert.equal(mounted.getCallCount(), 2, 'follow-up sends only on the second gesture');
  console.log(JSON.stringify({reproduction: 'enqueue_ack_erases_next_draft', beforeAck, afterAck, submittedMessages: mounted.getCallCount()}));
  mounted.unmount();
});

for (const processing of [false, true]) {
  test(`native ${processing ? 'busy' : 'idle'} ACK consumes only submitted rich draft`, async (t) => {
    const { container, restore } = installDom();
    t.after(restore);
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, processing);
    mounted.state.addAnnotation('quote A', 'note A');
    await mounted.pasteText('attachment A\n'.repeat(100));
    await mounted.submit();
    assert.equal(mounted.state.calls, 1);
    assert.equal(mounted.state.payloads[0].attachments.length, 1);
    mounted.typeText('unsent B');
    mounted.state.addAnnotation('quote B', 'note B');
    await mounted.pasteText('attachment B\n'.repeat(100));
    await mounted.resolve();
    assert.equal(mounted.text(), 'unsent B');
    assert.deepEqual(mounted.state.annotations.pendingAnnotations.map(a => a.note), ['note B']);
    await mounted.submit();
    assert.equal(mounted.state.calls, 2);
    assert.equal(mounted.state.payloads[1].attachments.length, 1);
    assert.match(mounted.state.payloads[1].attachments[0].content, /attachment B/);
    assert.deepEqual(mounted.state.payloads[1].annotations.map(a => a.note), ['note B']);
    await mounted.resolve();
    assert.equal(mounted.text(), '');
    assert.equal(mounted.state.annotations.pendingAnnotations.length, 0);
    mounted.unmount();
  });

  test(`native ${processing ? 'busy' : 'idle'} rejection retains rich payload and new draft, with explicit recovery`, async (t) => {
    const { container, restore } = installDom();
    t.after(restore);
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, processing);
    mounted.state.addAnnotation('quote A', 'note A');
    await mounted.pasteText('attachment A\n'.repeat(100));
    await mounted.submit();
    mounted.typeText('new B');
    mounted.state.addAnnotation('quote B', 'note B');
    await mounted.reject();
    assert.equal(mounted.text(), 'new B');
    assert.equal(mounted.state.result, false);
    assert.equal(mounted.state.annotations.pendingAnnotations.length, 2);
    assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
    mounted.recover();
    assert.match(mounted.text(), /new B/);
    assert.match(mounted.text(), /valuable follow-up draft/);
    await mounted.submit();
    assert.equal(mounted.state.payloads[1].attachments.length, 1);
    assert.equal(mounted.state.calls, 2);
    await mounted.resolve();
    assert.equal(mounted.text(), '');
    mounted.unmount();
  });
}

test('accepting a new turn evicts the previous turn\'s sent annotations and selection styles', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, false);
  t.after(() => { mounted.unmount(); restore(); });

  // Turn 1: annotated prompt is accepted; its sent marker stays for this turn.
  mounted.state.addAnnotation('turn one quote', 'turn one note');
  await mounted.submit();
  await mounted.resolve();
  assert.equal(mounted.state.annotations.pendingAnnotations.length, 0);
  assert.deepEqual(mounted.state.annotations.annotations.map((a) => a.note), ['turn one note']);
  assert.ok(mounted.state.annotations.annotations[0].sentAt, 'current turn sent marker must stay visible');

  // Turn 2 (annotation-only): accepting the new input evicts turn one's styles.
  mounted.state.addAnnotation('turn two quote', 'turn two note');
  await mounted.submit();
  await mounted.resolve();
  assert.deepEqual(
    mounted.state.annotations.annotations.map((a) => a.note),
    ['turn two note'],
    'previous turn annotation highlights/markers must be cleaned on next-turn acceptance',
  );

  // A plain turn with no new annotations still clears the leftover styles.
  mounted.typeText('plain follow-up without annotations');
  await mounted.submit();
  await mounted.resolve();
  assert.equal(mounted.state.annotations.annotations.length, 0);

  // Long sessions keep the annotation budget available turn after turn.
  for (let turn = 4; turn <= 24; turn++) {
    mounted.state.addAnnotation(`quote ${turn}`, `note ${turn}`);
    assert.ok(mounted.state.annotations.canAddAnnotation, `annotation budget must remain available (turn ${turn})`);
    await mounted.submit();
    await mounted.resolve();
    assert.equal(mounted.state.annotations.annotations.length, 1, 'sent annotations must not accumulate across turns');
  }
  assert.equal(mounted.state.annotations.pendingAnnotations.length, 0);
  assert.ok(mounted.state.annotations.canAddAnnotation);
});

test('multiple rejected submissions retain separate recoverable snapshots', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  await mounted.submit();
  mounted.typeText('second rejected draft');
  await mounted.reject();
  await mounted.submit();
  mounted.typeText('third current draft');
  await mounted.reject();
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 2);
  mounted.recover();
  mounted.recover();
  assert.match(mounted.text(), /valuable follow-up draft/);
  assert.match(mounted.text(), /second rejected draft/);
  assert.match(mounted.text(), /third current draft/);
  mounted.unmount();
});

test('actual NativeView provider action expressions expose Stop and refuse busy Codex Enter', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountProvider(container);
  assert.ok(container.querySelector('button[aria-label="workspace.nativeStop"]'));
  await mounted.stop();
  assert.deepEqual(mounted.state.stops, [['codex-test', 'native_session_stop_button', null]]);
  mounted.typeText('next Codex prompt');
  await mounted.enter();
  assert.equal(mounted.state.sends, 0);
  assert.equal(container.querySelector('[contenteditable="true"]').textContent, 'next Codex prompt');
  mounted.state.setProcessing(false);
  await mounted.enter();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mounted.state.sends, 1);
  mounted.unmount();
});

test('image chips added during ACK retain their identity and submit exactly once', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  await mounted.pasteImage('A.png');
  await mounted.submit();
  assert.equal(mounted.state.payloads[0].attachments[0].kind, 'image');
  const sentImageId = mounted.state.payloads[0].attachments[0].id;
  mounted.typeText('B only');
  await mounted.pasteImage('B.png');
  await mounted.resolve();
  assert.match(mounted.text(), /B only/);
  await mounted.submit();
  const images = mounted.state.payloads[1].attachments;
  assert.equal(images.length, 1);
  assert.equal(images[0].kind, 'image');
  assert.notEqual(images[0].id, sentImageId);
  assert.ok(images[0].base64Data);
  await mounted.resolve();
  assert.equal(mounted.text(), '');
  mounted.unmount();
});

test('annotation-only edits during rejection preserve the rejected snapshot for recovery', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  mounted.state.addAnnotation('original quote', 'original note');
  await mounted.submit();
  mounted.state.editAnnotation(mounted.state.annotations.pendingAnnotations[0].id, 'new note');
  await mounted.reject();
  assert.equal(mounted.text(), 'valuable follow-up draft');
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
  mounted.recover();
  assert.deepEqual(mounted.state.annotations.pendingAnnotations.map(a => a.note).sort(), ['new note', 'original note']);
  mounted.unmount();
});

test('image recovery renumbers conflicting placeholders and preserves chip identity', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  await mounted.pasteImage('A.png');
  await mounted.submit();
  const originalImage = mounted.state.payloads[0].attachments[0];
  mounted.typeText('B');
  await mounted.pasteImage('B.png');
  await mounted.reject();
  mounted.recover();
  await mounted.submit();
  const images = mounted.state.payloads[1].attachments;
  assert.equal(images.length, 2);
  assert.equal(new Set(images.map(a => a.placeholder)).size, 2);
  assert.equal(new Set(images.map(a => a.id)).size, 2);
  assert.ok(images.some(a => a.id === originalImage.id));
  for (const image of images) assert.ok(mounted.state.payloads[1].text.includes(image.placeholder));
  await mounted.resolve();
  mounted.unmount();
});

test('attachment-only replacement on rejected admission retains both unsent payloads', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  await mounted.pasteText('attachment A\n'.repeat(100));
  await mounted.submit();
  mounted.removeFirstAttachment();
  await mounted.pasteText('attachment B\n'.repeat(100));
  await mounted.reject();
  assert.equal(mounted.text(), 'valuable follow-up draft');
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
  mounted.recover();
  await mounted.submit();
  assert.equal(mounted.state.payloads[1].attachments.length, 2);
  assert.match(mounted.state.payloads[1].attachments[0].content, /attachment B/);
  assert.match(mounted.state.payloads[1].attachments[1].content, /attachment A/);
  await mounted.resolve();
  mounted.unmount();
});

for (const kind of ['text', 'plan_exit', 'ask_user_question']) {
  test(`actual attention ${kind} callback preserves rejected draft and removes optimistic row`, async (t) => {
    const { container, restore } = installDom();
    t.after(restore);
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true, kind);
    await mounted.submit();
    assert.equal(mounted.text(), 'valuable follow-up draft');
    assert.equal(mounted.state.optimistic.length, 1);
    await mounted.reject();
    assert.equal(mounted.state.result, false);
    assert.equal(mounted.state.optimistic.length, 0);
    assert.equal(mounted.text(), 'valuable follow-up draft');
    mounted.unmount();
  });
}

test('accepted attention reply keeps new draft and cannot become retryable on refresh failure', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true, 'plan_exit');
  await mounted.submit();
  mounted.typeText('new pending feedback');
  mounted.state.refreshFails = true;
  await mounted.resolve();
  assert.equal(mounted.state.result, true);
  assert.equal(mounted.text(), 'new pending feedback');
  assert.equal(mounted.state.optimistic.length, 1);
  assert.equal(container.querySelector('[data-composer-rejected-draft]'), null);
  mounted.unmount();
});

test('independent acceptance: restoring rejected annotations never overwrites a newer note at the supported limit', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  for (let i = 0; i < 20; i++) mounted.state.addAnnotation('quote ' + i, 'original note ' + i);
  assert.equal(mounted.state.annotations.pendingAnnotations.length, 20);
  const editedId = mounted.state.annotations.pendingAnnotations[0].id;
  await mounted.submit();
  mounted.state.editAnnotation(editedId, 'NEW UNSENT NOTE');
  await mounted.reject();
  assert.equal(mounted.state.annotations.pendingAnnotations.find(a => a.id === editedId).note, 'NEW UNSENT NOTE');
  mounted.recover();
  const pending = mounted.state.annotations.pendingAnnotations;
  console.log(JSON.stringify({finding:'annotation_recovery_at_limit', pendingNotes:pending.map(a=>a.note), recoveryRows:container.querySelectorAll('[data-composer-rejected-draft]').length}));
  assert.ok(pending.some(a => a.note === 'NEW UNSENT NOTE'), 'new unsent annotation must survive restoring its older rejected version');
  assert.equal(pending.length, 20);
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
  assert.match(container.querySelector('[role="alert"]').textContent, /composerRecoveryLimit/);
});

test('independent acceptance: running Codex does not present an enabled Send action that silently does nothing', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountProvider(container);
  t.after(() => { mounted.unmount(); restore(); });
  mounted.typeText('next Codex prompt');
  const send = container.querySelector('button[aria-label="workspace.composeSend"]');
  const stop = container.querySelector('button[aria-label="workspace.nativeStop"]');
  assert.ok(send);
  await mounted.clickSend();
  await mounted.enter();
  console.log(JSON.stringify({finding:'busy_codex_noop_send', sendDisabled:send.disabled, hasStop:Boolean(stop), sends:mounted.state.sends, draft:container.querySelector('[contenteditable="true"]').textContent}));
  assert.equal(send.disabled, true, 'unsupported busy submit must not be offered as enabled Send');
  assert.ok(stop && !stop.disabled, 'Stop must remain available while drafting');
  await mounted.stop();
  assert.equal(mounted.state.stops.length, 1);
});

test('independent acceptance: ACK does not leave visible image chips with no corresponding unsent payload', async (t) => {
  const { container, restore } = installDom();
  // FileReader completion can outlive a fixed short sleep under full-suite load.
  const readAsDataURL = FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL = function (file) {
    setTimeout(() => readAsDataURL.call(this, file), 80);
  };
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.pasteImage('submitted-A.png');
  await mounted.submit();
  const originalImage = mounted.state.payloads[0].attachments[0];
  mounted.appendText(' follow-up B about this image');
  await mounted.resolve();
  const afterAck = mounted.text();
  await mounted.submit();
  const second = mounted.state.payloads[1];
  console.log(JSON.stringify({finding:'image_reference_after_ack', afterAck, secondText:second.text, secondAttachments:second.attachments.map(a => a.id), previousImagePlaceholder:originalImage.placeholder}));
  await mounted.resolve();
  assert.ok(!second.text.includes(originalImage.placeholder) || second.attachments.some(a=>a.id===originalImage.id), 'visible image reference must either remain backed by its image payload or be consumed with the submitted draft');
});

test('independent acceptance: rejected snapshot preserves live DOM text in input-submit same tick', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.typeAndSubmitSameTick('EXACT_SUBMITTED_A');
  assert.equal(mounted.state.payloads[0].text, 'EXACT_SUBMITTED_A');
  mounted.typeText('NEW_B');
  await mounted.reject();
  const recoveryPreview = container.querySelector('[data-composer-rejected-draft]').textContent;
  mounted.recover();
  console.log(JSON.stringify({finding:'live_dom_rejected_snapshot', submitted:mounted.state.payloads[0].text, recoveryPreview, recoveredText:mounted.text()}));
  assert.ok(mounted.text().includes('EXACT_SUBMITTED_A'), 'recovery must contain the actual submitted text, not a stale React render');
});

for (const limit of ['count', 'chars']) {
  test(`recovery ${limit} capacity is transactional and retryable after making room`, async (t) => {
    const { container, restore } = installDom();
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true);
    t.after(() => { mounted.unmount(); restore(); });
    const count = limit === 'count' ? 19 : 4;
    for (let i = 0; i < count; i++) mounted.state.addAnnotation(
      limit === 'count' ? `quote ${i}` : `${i}${'q'.repeat(9999)}`,
      limit === 'count' ? `original ${i}` : 'o'.repeat(1000),
    );
    const editedId = mounted.state.annotations.pendingAnnotations[0].id;
    await mounted.pasteText('A attachment\n'.repeat(100));
    await mounted.submit();
    mounted.state.editAnnotation(editedId, limit === 'count' ? 'NEW' : 'N'.repeat(1000));
    mounted.state.addAnnotation(limit === 'count' ? 'new extra quote' : 'b'.repeat(12000), limit === 'count' ? 'new extra note' : 'b'.repeat(4000));
    const extraId = mounted.state.annotations.pendingAnnotations.at(-1).id;
    mounted.typeText('current B');
    await mounted.reject();
    const before = structuredClone(mounted.state.annotations.annotations);
    mounted.recover();
    assert.deepEqual(mounted.state.annotations.annotations, before, 'failed recovery must mutate no annotations');
    assert.equal(mounted.text(), 'current B', 'failed recovery must mutate no editor content');
    assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
    mounted.state.removeAnnotation(extraId);
    mounted.recover();
    assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.ok(mounted.state.annotations.pendingAnnotations.some(a => a.id === editedId && a.note.startsWith('N')));
    assert.ok(mounted.state.annotations.pendingAnnotations.some(a => a.note === (limit === 'count' ? 'original 0' : 'o'.repeat(1000))));
    assert.match(mounted.text(), /current B/);
    assert.match(mounted.text(), /valuable follow-up draft/);
    await mounted.submit();
    assert.equal(mounted.state.payloads[1].attachments.length, 1);
    await mounted.resolve();
  });
}

test('two annotation restores in one React batch share capacity and cannot evict existing input', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  for (let i = 0; i < 19; i++) mounted.state.addAnnotation(`quote ${i}`, `note ${i}`);
  const snapshot = note => [{ id: note, quote: note, note, createdAt: new Date().toISOString() }];
  assert.deepEqual(mounted.state.restoreTwice(snapshot('first'), snapshot('second')), [true, false]);
  assert.equal(mounted.state.annotations.annotations.length, 20);
  assert.ok(mounted.state.annotations.annotations.some(a => a.note === 'note 0'));
  assert.ok(mounted.state.annotations.annotations.some(a => a.note === 'first'));
  assert.equal(mounted.state.annotations.annotations.some(a => a.note === 'second'), false);
});

test('same-tick structured submission recovers its image chip and exact appended text', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.pasteImage('A.png');
  await mounted.appendAndSubmitSameTick('EXACT_SAME_TICK');
  const first = mounted.state.payloads[0];
  mounted.typeText('NEW B');
  await mounted.reject();
  mounted.recover();
  await mounted.submit();
  const second = mounted.state.payloads[1];
  assert.match(second.text, /EXACT_SAME_TICK/);
  assert.match(second.text, /NEW B/);
  assert.equal(second.attachments.length, 1);
  assert.equal(second.attachments[0].id, first.attachments[0].id);
  assert.ok(second.text.includes(second.attachments[0].placeholder));
  await mounted.resolve();
});

test('retained image after ACK reserves its placeholder and remains consistent with a newly pasted image', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.pasteImage('A.png');
  await mounted.submit();
  mounted.appendText('follow-up');
  await mounted.resolve();
  await mounted.pasteImage('B.png');
  await mounted.submit();
  const images = mounted.state.payloads[1].attachments;
  assert.equal(images.length, 2);
  assert.equal(new Set(images.map(image => image.placeholder)).size, 2);
  for (const image of images) assert.ok(mounted.state.payloads[1].text.includes(image.placeholder));
  await mounted.resolve();
});

test('recovering distinct snapshots in the same batch preserves both and consumes each row once', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.submit();
  mounted.typeText('SECOND_REJECT');
  await mounted.reject();
  await mounted.submit();
  mounted.typeText('CURRENT_THIRD');
  await mounted.reject();
  mounted.recoverAllSameTick();
  assert.match(mounted.text(), /CURRENT_THIRD/);
  assert.match(mounted.text(), /SECOND_REJECT/);
  assert.match(mounted.text(), /valuable follow-up draft/);
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
});

test('double-click recovery cannot duplicate a rejected draft', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  await mounted.submit();
  mounted.typeText('CURRENT_B');
  await mounted.reject();
  mounted.recoverTwiceSameTick();
  assert.equal(mounted.text().split('valuable follow-up draft').length - 1, 1);
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
});

 test('independent review: distinct annotation anchors survive one recovery transaction', async (t) => {
  const {container,restore}=installDom();
  const harness=await (importedHarnessPromise ??= importHarness());
  const mounted=harness.mountFailure(container,true);
  t.after(()=>{mounted.unmount();restore();});
  const anchor=key=>({startItemKey:key,startOffset:0,endItemKey:key,endOffset:25});
  mounted.state.addAnnotation('same repeated source text','check this',anchor('message-a'));
  mounted.state.addAnnotation('same repeated source text','check this',anchor('message-b'));
  assert.equal(mounted.state.annotations.pendingAnnotations.length,2);
  await mounted.submit();
  for (const item of [...mounted.state.annotations.pendingAnnotations]) mounted.state.removeAnnotation(item.id);
  mounted.typeText('New current B');
  await mounted.reject();
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length,1);
  mounted.recover();
  console.log(JSON.stringify({independent:'distinct-anchor-recovery',actual:mounted.state.annotations.pendingAnnotations,rows:container.querySelectorAll('[data-composer-rejected-draft]').length}));
  assert.equal(mounted.state.annotations.pendingAnnotations.length,2,'two separate highlights must not collapse solely because quote/note match');
 });

test('recovery distinguishes same-message offsets and deduplicates an already-restored anchored version', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { mounted.unmount(); restore(); });
  const anchor = offset => ({ startItemKey: 'same-message', startOffset: offset, endItemKey: 'same-message', endOffset: offset + 4 });
  mounted.state.addAnnotation('same', 'note', anchor(0));
  mounted.state.addAnnotation('same', 'note', anchor(10));
  const original = structuredClone(mounted.state.annotations.pendingAnnotations);
  mounted.state.editAnnotation(original[0].id, 'new note');
  const result = mounted.state.restoreTwice(original, original);
  assert.deepEqual(result, [true, true]);
  const pending = mounted.state.annotations.pendingAnnotations;
  assert.equal(pending.length, 3, 'edited original plus the two distinct original anchored versions');
  assert.equal(pending.filter(a => a.note === 'note' && a.anchor.startOffset === 0).length, 1);
  assert.equal(pending.filter(a => a.note === 'note' && a.anchor.startOffset === 10).length, 1);
  assert.equal(pending.filter(a => a.note === 'new note').length, 1);
});

for (const editDuringRead of [false, true]) {
  test(`additional acceptance: skill-read failure ${editDuringRead ? 'retains rejected A alongside new B' : 'preserves unchanged draft'}`, async (t) => {
    const { container, restore } = installDom();
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true);
    t.after(() => { delete globalThis.__acceptanceInvoke; mounted.unmount(); restore(); });
    const requested = [];
    globalThis.__acceptanceInvoke = (command, args) => {
      if (command !== 'read_skill_files') return [];
      requested.push(args);
      return new Promise((resolve, reject) => { mounted.state.resolve = resolve; mounted.state.reject = reject; });
    };
    const original = 'ORIGINAL_A use [$review](/tmp/qa-review/SKILL.md)';
    mounted.typeText(original);
    await mounted.submit();
    assert.equal(requested.length, 1);
    assert.equal(mounted.state.calls, 0, 'admission should wait for selected skill content');
    if (editDuringRead) mounted.typeText('NEW_UNSENT_B');
    await mounted.reject();
    const recoveryRows = container.querySelectorAll('[data-composer-rejected-draft]').length;
    console.log(JSON.stringify({additional:'skill_read_failure', editDuringRead, draft:mounted.text(), recoveryRows, admissionCalls:mounted.state.calls}));
    if (!editDuringRead) {
      assert.equal(mounted.text(), original);
    } else {
      assert.equal(mounted.text(), 'NEW_UNSENT_B');
      assert.equal(recoveryRows, 1, 'A failed before admission and must remain recoverable after B replaces it');
      mounted.recover();
      assert.match(mounted.text(), /ORIGINAL_A/);
      assert.match(mounted.text(), /NEW_UNSENT_B/);
    }
  });
}

for (const failure of ['unreadable', 'annotation-validation']) {
  for (const editDuringRead of [false, true]) {
    test(`pre-admission ${failure} ${editDuringRead ? 'retains snapshot beside new draft' : 'leaves unchanged draft in place'}`, async (t) => {
      const { container, restore } = installDom();
      const harness = await (importedHarnessPromise ??= importHarness());
      const invalidAnnotations = failure === 'annotation-validation'
        ? Array.from({ length: 21 }, (_, i) => ({ id: `annotation-${i}`, quote: `quote ${i}`, note: 'note', createdAt: new Date().toISOString() }))
        : null;
      const mounted = harness.mountFailure(container, true, null, invalidAnnotations);
      t.after(() => { delete globalThis.__acceptanceInvoke; mounted.unmount(); restore(); });
      globalThis.__acceptanceInvoke = command => command === 'read_skill_files'
        ? new Promise(resolve => { mounted.state.resolve = resolve; }) : [];
      const original = 'ORIGINAL_A use [$review](/tmp/qa-review/SKILL.md)';
      mounted.typeText(original);
      await mounted.submit();
      assert.equal(mounted.state.calls, 0);
      if (editDuringRead) mounted.typeText('NEW_UNSENT_B');
      await mounted.resolve(failure === 'unreadable'
        ? [{ path: '/tmp/qa-review/SKILL.md', name: 'review', content: '', diagnostics: ['permission denied'] }]
        : []);
      assert.equal(mounted.state.calls, 0, 'preparation rejection cannot reach admission');
      assert.equal(mounted.text(), editDuringRead ? 'NEW_UNSENT_B' : original);
      assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, editDuringRead ? 1 : 0);
      if (editDuringRead) {
        assert.match(container.querySelector('[data-composer-rejected-draft]').textContent, /ORIGINAL_A/);
        mounted.recover();
        if (failure === 'unreadable') {
          assert.match(mounted.text(), /ORIGINAL_A/);
          assert.match(mounted.text(), /NEW_UNSENT_B/);
        } else {
          assert.equal(mounted.text(), 'NEW_UNSENT_B', 'invalid over-capacity annotation snapshot stays recoverable without corrupting current input');
          assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
        }
      }
    });
  }
}

test('unreadable skill read failure shows a persistent inline error strip with retry and dismiss', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  globalThis.__acceptanceToasts = [];
  t.after(() => { delete globalThis.__acceptanceInvoke; delete globalThis.__acceptanceToasts; mounted.unmount(); restore(); });
  globalThis.__acceptanceInvoke = command => command === 'read_skill_files'
    ? new Promise(resolve => { mounted.state.resolve = resolve; }) : [];
  const original = 'ORIGINAL_A use [$review](/tmp/qa-review/SKILL.md)';
  mounted.typeText(original);
  await mounted.submit();
  assert.equal(mounted.state.calls, 0, 'admission waits for skill content');
  await mounted.resolve([
    {
      skillFile: '/tmp/qa-review/SKILL.md',
      name: null,
      content: '',
      diagnostics: ['Failed to read selected skill: ENOENT (os error 2)'],
    },
  ]);
  assert.equal(mounted.state.calls, 0, 'unreadable skill aborts before admission');
  assert.equal(mounted.text(), original, 'draft stays in the composer');
  assert.ok(
    globalThis.__acceptanceToasts.some(entry => entry.message === 'workspace.composerSkillReadFailed'),
    'toast feedback is retained',
  );
  const strip = container.querySelector('[data-composer-skill-read-error]');
  assert.ok(strip, 'inline skill-read error strip must render');
  assert.equal(strip.getAttribute('role'), 'alert');
  assert.match(strip.textContent, /composerSkillReadErrorTitle/);
  assert.match(strip.textContent, /composerSkillReadErrorHint/);
  assert.match(strip.textContent, /qa-review/, 'failing skill identity uses the skill directory name');
  await mounted.click('[data-composer-skill-read-error] [aria-label="common.close"]');
  assert.equal(container.querySelector('[data-composer-skill-read-error]'), null, 'dismiss removes the strip');

  // Retry: the same draft resubmits, and a now-readable skill reaches admission
  // while the strip is cleared by the new submit attempt.
  globalThis.__acceptanceInvoke = () => [];
  mounted.typeText(original);
  await mounted.submit();
  assert.equal(container.querySelector('[data-composer-skill-read-error]'), null, 'a fresh submit attempt clears the stale strip');
  assert.equal(mounted.state.calls, 1, 'retry path reaches admission once the skill reads');
  await mounted.resolve();
});

test('skill read transport failure also surfaces the inline error strip without skill names', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { delete globalThis.__acceptanceInvoke; mounted.unmount(); restore(); });
  globalThis.__acceptanceInvoke = command => command === 'read_skill_files'
    ? new Promise((resolve, reject) => { mounted.state.reject = reject; }) : [];
  mounted.typeText('use [$review](/tmp/qa-review/SKILL.md)');
  await mounted.submit();
  await mounted.reject(new Error('skill read transport down'));
  assert.equal(mounted.state.calls, 0);
  const strip = container.querySelector('[data-composer-skill-read-error]');
  assert.ok(strip, 'inline skill-read error strip must render for transport failures');
  assert.equal(strip.getAttribute('role'), 'alert');
  assert.match(strip.textContent, /composerSkillReadErrorTitle/);
  assert.doesNotMatch(strip.textContent, /qa-review/, 'transport failure cannot blame a specific skill');
  assert.ok(container.querySelector('[data-composer-skill-read-retry]'), 'retry action stays available');
});

test('failed skill preprocessing preserves both drafts rich payload and requires explicit recovery and retry', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true);
  t.after(() => { delete globalThis.__acceptanceInvoke; mounted.unmount(); restore(); });
  globalThis.__acceptanceInvoke = command => command === 'read_skill_files'
    ? new Promise((resolve, reject) => { mounted.state.resolve = resolve; mounted.state.reject = reject; }) : [];
  mounted.typeText('ORIGINAL_A use [$review](/tmp/qa-review/SKILL.md)');
  mounted.state.addAnnotation('A quote', 'A note');
  await mounted.pasteImage('A.png');
  await mounted.submit();
  mounted.typeText('NEW_B');
  mounted.state.addAnnotation('B quote', 'B note');
  await mounted.pasteImage('B.png');
  await mounted.reject();
  assert.equal(mounted.state.calls, 0);
  assert.match(mounted.text(), /NEW_B/);
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 1);
  mounted.recover();
  assert.equal(mounted.state.calls, 0, 'restore is not an automatic send');
  delete globalThis.__acceptanceInvoke;
  await mounted.submit();
  assert.equal(mounted.state.calls, 1);
  const delivered = mounted.state.payloads[0];
  assert.match(delivered.text, /NEW_B/);
  assert.match(delivered.text, /ORIGINAL_A/);
  assert.equal(delivered.attachments.length, 2);
  assert.equal(new Set(delivered.attachments.map(a => a.placeholder)).size, 2);
  assert.deepEqual(delivered.annotations.map(a => a.note), ['A note', 'B note']);
  await mounted.resolve();
  assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
});

for (const [text, decision] of [['继续执行', 'approve'], ['把最终回复改为 PLAN_REVISED，然后重新提交计划确认。', 'revise']]) {
  test(`active Plan composer typed ${decision} answers exact attention instead of queueing`, async (t) => {
    const { container, restore } = installDom();
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true, null, null, { plan: true });
    t.after(() => { mounted.unmount(); restore(); });
    mounted.typeText(text);
    await mounted.submit();
    assert.equal(mounted.state.queueCalls.length, 0, 'Plan reply must not enter FIFO waiting on its own active command');
    assert.equal(mounted.state.responses.length, 1);
    assert.deepEqual(mounted.state.responses[0], {
      runtimeId: 'review-only-runtime',
      payload: {
        toolUseId: 'real-exit-plan-tool', expectedAttentionSeq: 42, promptType: 'plan_exit',
        displayText: text,
        answers: decision === 'approve' ? { decision, approval: text } : { decision, feedback: text },
        promptAnnotations: [],
      },
    });
    await mounted.resolve();
    assert.equal(mounted.state.result, true);
    assert.equal(mounted.text(), '');
  });
}

for (const scenario of ['noPlan', 'attachments', 'hardblock', 'synthetic', 'cron']) {
  test(`active composer ${scenario} retains ordinary inbox route`, async (t) => {
    const { container, restore } = installDom();
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true, null, null, {
      plan: scenario === 'attachments' || scenario === 'hardblock' || scenario === 'cron',
      hardBlock: scenario === 'hardblock', synthetic: scenario === 'synthetic',
    });
    t.after(() => { mounted.unmount(); restore(); });
    mounted.typeText(scenario === 'cron' ? '/ccem-cron 每天检查项目状态' : 'ordinary follow-up');
    if (scenario === 'attachments') await mounted.pasteImage('follow-up.png');
    await mounted.submit();
    assert.equal(mounted.state.responses.length, 0);
    assert.equal(mounted.state.queueCalls.length, 1);
    assert.deepEqual(mounted.state.queueCalls[0].options, { queuedBehindTurn: true });
    if (scenario === 'attachments') assert.equal(mounted.state.queueCalls[0].prompts[0].attachments.length, 1);
    await mounted.resolve();
    assert.equal(mounted.state.result, true);
  });
}

for (const editDuringReply of [false, true]) {
  test(`active Plan typed revision rejection retains ${editDuringReply ? 'new and rejected drafts' : 'unchanged draft'} without fallback enqueue`, async (t) => {
    const { container, restore } = installDom();
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mountFailure(container, true, null, null, { plan: true });
    t.after(() => { mounted.unmount(); restore(); });
    mounted.typeText('REVISION_A: change plan before executing');
    await mounted.submit();
    assert.equal(mounted.state.responses.length, 1);
    assert.equal(mounted.state.queueCalls.length, 0);
    if (editDuringReply) mounted.typeText('UNSENT_NEW_B');
    await mounted.reject();
    assert.equal(mounted.state.result, false);
    assert.equal(mounted.state.queueCalls.length, 0, 'failed attention response must never fall back to queue');
    assert.equal(mounted.state.optimistic.length, 0);
    assert.equal(mounted.text(), editDuringReply ? 'UNSENT_NEW_B' : 'REVISION_A: change plan before executing');
    if (editDuringReply) {
      mounted.recover();
      assert.match(mounted.text(), /REVISION_A/);
      assert.match(mounted.text(), /UNSENT_NEW_B/);
    }
  });
}

test('active Plan typed approval classifies display text while preserving expanded request and annotations', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mountFailure(container, true, null, null, { plan: true, queueAnnotationsBlocked: true });
  t.after(() => { mounted.unmount(); restore(); });
  mounted.state.addAnnotation('reviewed plan source', 'keep the validation step');
  mounted.typeText('继续执行');
  await mounted.submit();
  assert.equal(mounted.state.queueCalls.length, 0, 'attention reply cannot join or validate unrelated aggregate queue');
  assert.equal(mounted.state.responses.length, 1);
  const { runtimeId, payload } = mounted.state.responses[0];
  assert.equal(runtimeId, 'review-only-runtime');
  assert.equal(payload.toolUseId, 'real-exit-plan-tool');
  assert.equal(payload.expectedAttentionSeq, 42);
  assert.equal(payload.promptType, 'plan_exit');
  assert.equal(payload.displayText, '继续执行', 'visible approval must exclude expanded context');
  assert.equal(payload.answers.decision, 'approve', 'classification must use visible text, not expanded request');
  assert.notEqual(payload.answers.approval, payload.displayText);
  assert.match(payload.answers.approval, /继续执行/);
  assert.match(payload.answers.approval, /reviewed plan source/);
  assert.match(payload.answers.approval, /keep the validation step/);
  assert.deepEqual(payload.promptAnnotations, [{ quote: 'reviewed plan source', note: 'keep the validation step' }]);
  await mounted.resolve();
  assert.equal(mounted.state.result, true);
  assert.equal(mounted.text(), '');
  assert.equal(mounted.state.annotations.pendingAnnotations.length, 0);
});

for (const scenario of [
  { name: 'idle live', processing: false },
  { name: 'busy live', processing: true },
  { name: 'interactive text', interactiveKind: 'text' },
  { name: 'interactive Plan', interactiveKind: 'plan_exit' },
  { name: 'interactive question', interactiveKind: 'ask_user_question' },
  { name: 'new conversation', launch: 'compose' },
  { name: 'history continuation', launch: 'history' },
]) {
  test(`actual ${scenario.name} lost ACK preserves editor but cannot restore a sendable submission`, async (t) => {
    const { container, restore } = installDom();
    t.after(restore);
    const harness = await (importedHarnessPromise ??= importHarness());
    window.__ccemRecoveryTest = true;
    globalThis.__acceptanceToasts = [];
    t.after(() => { delete globalThis.__acceptanceToasts; });
    const key = `lost-ack-${scenario.name}`;
    const image = { id: 'ack-image', kind: 'image', source: 'paste', name: 'context.png',
      placeholder: '[Image #1]', mediaType: 'image/png', base64Data: 'aGVsbG8=', byteSize: 5, objectUrl: null };
    harness.seedRecovery(key, 'saved context [Image #1]', [image]);
    const route = { launch: scenario.launch, recoveryKey: key };
    const mounted = harness.mountFailure(container, Boolean(scenario.processing), scenario.interactiveKind, null, route);
    await mounted.submit();
    assert.equal(mounted.state.calls, 1);
    await mounted.reject(new Error('transport disconnected after request dispatch'));
    assert.equal(mounted.state.result, 'delivery_uncertain');
    assert.deepEqual(mounted.state.errors, []);
    assert.deepEqual(globalThis.__acceptanceToasts, [{
      kind: 'warning', message: 'workspace.composerDeliveryUncertain', options: { id: 'composer-delivery-uncertain' },
    }]);
    if (scenario.interactiveKind) assert.deepEqual(mounted.state.warnings, [{
      message: 'workspace.composerDeliveryUncertain', options: { id: 'composer-delivery-uncertain' },
    }], 'interactive reply uses the same toast id as Composer for deduplication');
    assert.match(mounted.text(), /saved context/);
    assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
    assert.equal(harness.recoveryCounts().uncertain, 1);
    assert.equal(harness.recoveryDraft(key), null);
    mounted.unmount();
    const remounted = harness.mountFailure(container, Boolean(scenario.processing), scenario.interactiveKind, null, route);
    assert.equal(remounted.text(), '');
    assert.equal(remounted.state.calls, 0);
    assert.equal(container.querySelectorAll('[data-composer-attachment-chip]').length, 0);
    assert.equal(harness.recoveryCounts().uncertain, 1);
    remounted.unmount();
  });
}

for (const launch of ['compose', 'history']) {
  test(`actual ${launch} preflight failure keeps its draft definitely unsubmitted`, async (t) => {
    const { container, restore } = installDom();
    t.after(restore);
    const harness = await (importedHarnessPromise ??= importHarness());
    window.__ccemRecoveryTest = true;
    const key = `preflight-${launch}`;
    harness.seedRecovery(key, 'unsubmitted draft', []);
    const mounted = harness.mountFailure(container, false, null, null, { launch, recoveryKey: key, preflightFailure: true });
    await mounted.submit();
    assert.equal(mounted.state.calls, 0);
    assert.equal(mounted.state.result, false);
    assert.equal(harness.recoveryDraft(key).text, 'unsubmitted draft');
    assert.equal(harness.recoveryCounts().uncertain, 0);
    mounted.unmount();
  });
}

test('only audited native pre-admission failures are classified as definite rejection', async () => {
  const harness = await (importedHarnessPromise ??= importHarness());
  for (const error of [
    'Failed to queue native input: client_message_id must not be empty',
    'INTERACTIVE_ATTENTION_STALE: occurrence expired',
    'PLAN_SETTINGS_NOT_APPLIED: interactive reply was not sent',
    'PLAN_SETTINGS_ACK_TIMEOUT: interactive reply was not sent',
  ]) assert.equal(harness.classifyNativeFailure(new Error(error)), false);
  for (const error of [
    'NATIVE_QUEUE_ENQUEUE_REJECTED', 'transport disconnected',
    'DELIVERY_UNCERTAIN: prompt may have reached helper',
    'INTERACTIVE_RESPONSE_ACK_TIMEOUT: no acknowledgement',
    'Native send task failed: worker exited',
  ]) assert.equal(harness.classifyNativeFailure(new Error(error)), 'delivery_uncertain');
});
