import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const componentScopes = {
  WorkspaceNativeSessionView: 'session.runtime_id',
  WorkspaceNativeSessionViewComponent: 'session.runtime_id',
  WorkspaceNativeSessionViewContent: 'session.runtime_id',
  WorkspaceTranscriptList: '"all"',
  WorkspaceToolDigestComponent: 'entries[0]?.block?.id ?? entries[0]?.thinking?.key ?? "empty"',
  WorkspaceMessageBubbleComponent: 'message.uuid ?? "message"',
  WorkspaceSessionComposer: 'recoveryDraftKey ?? "composer"',
  PromptArea: 'dataTestId ?? "editor"',
};

// Insert a counter in the actual function body, never in the memo wrapper.
// This supports declarations and named expressions inside memo/forwardRef.
export function instrumentComponentRenders(source, fileName) {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const insertions = [];
  const components = [];
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.body && node.name) {
      const name = node.name.text;
      let scope = componentScopes[name];
      if (scope && name.startsWith('WorkspaceNativeSessionView')) {
        const parameter = node.parameters[0]?.name;
        if (parameter && ts.isIdentifier(parameter)) {
          scope = `${parameter.text}.session.runtime_id`;
        } else if (parameter && ts.isObjectBindingPattern(parameter)) {
          const session = parameter.elements.find((element) =>
            (element.propertyName?.getText(parsed) ?? element.name.getText(parsed)) === 'session');
          const rest = parameter.elements.find((element) => element.dotDotDotToken);
          if (session) scope = `${session.name.getText(parsed)}.runtime_id`;
          else if (rest) scope = `${rest.name.getText(parsed)}.session.runtime_id`;
          else throw new Error(`Cannot resolve native session render scope for ${name}`);
        }
      }
      if (scope) {
        insertions.push({ at: node.body.getStart(parsed) + 1,
          text: `\n globalThis.__workspaceInteractionProbe?.render(${JSON.stringify(name)}, ${scope});\n` });
        components.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  let instrumented = source;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    instrumented = instrumented.slice(0, insertion.at) + insertion.text + instrumented.slice(insertion.at);
  }
  return { source: instrumented, components };
}

export function interactionPerformancePlugin({ desktop, repository, baseline, revision, manifest }) {
  const sourcePrefix = `${path.join(desktop, 'src')}${path.sep}`;
  return {
    name: 'workspace-interaction-performance',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
        path: 'core', namespace: 'interaction-performance-ipc',
      }));
      builder.onResolve({ filter: /^\.\/core\.js$/ }, ({ importer }) => {
        const normalized = importer.split(path.sep).join('/');
        if (!normalized.includes('/@tauri-apps/api/')) return undefined;
        // Tauri event/window helpers use relative imports, so intercept those
        // too. The stub's absolute re-export of core.js remains untouched.
        return { path: 'core', namespace: 'interaction-performance-ipc' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'interaction-performance-ipc' }, () => ({
        loader: 'js', resolveDir: desktop,
        contents: `
          export * from ${JSON.stringify(path.join(desktop, 'node_modules/@tauri-apps/api/core.js'))};
          export function invoke(...args) { return globalThis.__workspaceInteractionInvoke(...args); }
        `,
      }));
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: fileName }) => {
        if (!fileName.startsWith(sourcePrefix)) return undefined;
        const relative = path.relative(repository, fileName).split(path.sep).join('/');
        let source;
        if (baseline) {
          // No fallback: an untracked production import in a baseline is a build error.
          source = execFileSync('git', ['show', `${revision}:${relative}`], {
            cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
          });
        } else {
          source = await fs.readFile(fileName, 'utf8');
        }
        const instrumented = instrumentComponentRenders(source, fileName);
        manifest.components.push(...instrumented.components);
        manifest.productionModules.push(relative);
        return { contents: instrumented.source, loader: fileName.endsWith('x') ? 'tsx' : 'ts',
          resolveDir: path.dirname(fileName) };
      });
    },
  };
}
