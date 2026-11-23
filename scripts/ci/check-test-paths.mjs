#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const advice = {
  'esm-fixture-import': 'Use importFixture(filePath) from the shared fixture-paths helper for filesystem imports.',
  'rust-link-target': 'Use crate::test_support::assert_symlink_target for link target identity, or document an exact-spelling exception.',
};

function allowed(source, offset, rule) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const previousLine = source.slice(0, lineStart).trimEnd().split('\n').at(-1) ?? '';
  return new RegExp(`^\\s*// test-path-allow: ${rule} -- \\S.+$`).test(previousLine);
}

function safeImportArgument(node) {
  if (!node) return false;
  if (ts.isStringLiteralLike(node)) {
    return !/^(?:file:|[A-Za-z]:|[/\\])/.test(node.text);
  }
  if (ts.isTemplateExpression(node)) {
    if (node.head.text.startsWith('data:')) return true;
    // Existing correctly escaped, cache-busted fixtures remain supported.
    return node.head.text === '' && safeImportArgument(node.templateSpans[0]?.expression)
      && node.templateSpans[0].literal.text.startsWith('?');
  }
  return ts.isPropertyAccessExpression(node) && node.name.text === 'href'
    && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'pathToFileURL';
}

// A small lexical mask keeps strings/comments (including Rust raw strings)
// out of the direct-assertion check. It is intentionally not a Rust linter.
function maskRustLiterals(source) {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:br|r)(#+)?"[\s\S]*?"\1|b?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|.)|[^'\\\n])'/gu,
    (value) => value.replace(/[^\n]/g, ' '));
}

function directLinkComparison(body) {
  // Only inspect the two operands themselves. Error/boolean checks and helpers
  // consuming a read_link result are different contracts and must stay intact.
  let depth = 0;
  let start = 0;
  const operands = [];
  for (let index = 0; index <= body.length && operands.length < 2; index++) {
    const character = body[index];
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
    if ((character === ',' && depth === 0) || index === body.length) {
      operands.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  return operands.some((operand) => {
    const call = /^(?:&\s*)?(?:\w+::)*read_link\s*\(/.exec(operand);
    if (!call) return false;
    let end = call[0].length;
    let nesting = 1;
    for (; end < operand.length && nesting; end++) {
      if (operand[end] === '(') nesting++;
      else if (operand[end] === ')') nesting--;
    }
    const rest = operand.slice(end).trim();
    return rest === '' || /^\.\s*(?:unwrap|expect)\s*\([^()]*\)\s*$/.test(rest);
  });
}

export function checkSource(filename, source) {
  const issues = [];
  function report(offset, rule) {
    if (!allowed(source, offset, rule)) issues.push({
      file: filename,
      line: source.slice(0, offset).split('\n').length,
      rule,
      message: advice[rule],
    });
  }
  if (/\.[cm]?[jt]sx?$/.test(filename)) {
    const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && !safeImportArgument(node.arguments[0])) report(node.getStart(parsed), 'esm-fixture-import');
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  } else if (filename.endsWith('.rs')) {
    const masked = maskRustLiterals(source);
    for (const match of masked.matchAll(/\bassert_(?:eq|ne)!\s*\(/g)) {
      let depth = 1;
      let end = match.index + match[0].length;
      const start = end;
      for (; end < masked.length && depth; end++) {
        if (masked[end] === '(') depth++;
        else if (masked[end] === ')') depth--;
      }
      if (directLinkComparison(masked.slice(start, end - 1))) report(match.index, 'rust-link-target');
    }
  }
  return issues;
}

export function checkRepository(root) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8',
  }).split('\0').filter(Boolean);
  return files.filter((file) => file.endsWith('.rs') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      || /(?:^|\/)test\/helpers\/.*\.mjs$/.test(file))
    .flatMap((file) => checkSource(file, fs.readFileSync(path.join(root, file), 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const issues = checkRepository(root);
  for (const issue of issues) console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
  if (issues.length) process.exitCode = 1;
  else console.log('Test path checks passed.');
}
