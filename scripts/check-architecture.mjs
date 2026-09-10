import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const contracts = path.join(root, 'shared/contracts');
const failures = [];

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : [filename];
  });
}

function checkContractDependency(filename, specifier) {
  const target = specifier.startsWith('@contracts/')
    ? path.join(contracts, specifier.slice('@contracts/'.length))
    : specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier) : null;
  const relative = target && path.relative(contracts, target);
  if (!target || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    failures.push(`${path.relative(root, filename)}: portable contracts cannot depend on ${specifier}`);
  }
}

// Portable wire types are compiled by both applications. Runtime values or an
// import of a UI/database type would silently recreate the coupling this removes.
for (const filename of filesIn(contracts)) {
  if (!filename.endsWith('.ts')) {
    failures.push(`${path.relative(root, filename)}: contracts must be TypeScript type declarations`);
    continue;
  }
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) continue;
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) {
      checkContractDependency(filename, statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.isTypeOnly) {
      if (statement.moduleSpecifier) checkContractDependency(filename, statement.moduleSpecifier.text);
    } else {
      failures.push(`${path.relative(root, filename)}: only type aliases and type-only imports/exports are allowed`);
    }
  }
  function visit(node) {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      checkContractDependency(filename, node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

// Terminal permissions belong to preferences, never the chat UI. Keep this
// removed dependency edge from reconnecting the auth → shell → chat cycle.
for (const filename of filesIn(path.join(root, 'src/modules/shell')).filter(file => /\.tsx?$/.test(file))) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteral(node) && /^@\/modules\/chat(?:\/|$)/.test(node.text)) {
      failures.push(`${path.relative(root, filename)}: shell must not depend on the chat module`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log('Portable contracts and terminal dependency boundary passed.');
}
