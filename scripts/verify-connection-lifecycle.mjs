import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const toolsDirectory = path.resolve(process.argv[2] ?? 'src/tools');
const errors = [];

function isMethodCall(callExpression, methodName) {
  const expression = callExpression.expression;
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }

  if (expression.name.text !== methodName || !ts.isIdentifier(expression.expression)) {
    return null;
  }

  return expression.expression.text;
}

function isAwaitedMethodCall(node, methodName) {
  if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)) {
    return null;
  }

  return isMethodCall(node.expression, methodName);
}

function containsNode(container, node) {
  return node.pos >= container.pos && node.end <= container.end;
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${position.line + 1}:${position.character + 1}`;
}

function isFunctionLikeWithBody(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) && node.body;
}

function resolverParameterNames(node) {
  return node.parameters
    .filter((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text.startsWith('getConnectionString'))
    .map((parameter) => parameter.name.text);
}

function containsResolverCall(node, resolverNames) {
  let found = false;

  function visit(child) {
    if (found) {
      return;
    }

    if (ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      resolverNames.includes(child.expression.text)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(child, visit);
  }

  visit(node);
  return found;
}

function collectResolvedConnectionVariables(functionNode, resolverNames) {
  const resolvedVariables = new Set();

  if (resolverNames.length === 0) {
    return resolvedVariables;
  }

  function visit(node) {
    if (isFunctionLikeWithBody(node) && node !== functionNode) {
      return;
    }

    if (ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsResolverCall(node.initializer, resolverNames)
    ) {
      resolvedVariables.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(functionNode.body);
  return resolvedVariables;
}

function isResolvedConnectionExpression(expression, resolutionContext) {
  if (!resolutionContext || resolutionContext.resolverNames.length === 0) {
    return true;
  }

  if (containsResolverCall(expression, resolutionContext.resolverNames)) {
    return true;
  }

  return ts.isIdentifier(expression) && resolutionContext.resolvedVariables.has(expression.text);
}

function hasAwaitedDisconnect(block, receiverName) {
  let found = false;

  function visit(node) {
    if (found) {
      return;
    }

    const disconnectReceiver = isAwaitedMethodCall(node, 'disconnect');
    if (disconnectReceiver === receiverName) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(block);
  return found;
}

function hasMatchingFinally(ancestors, node, receiverName) {
  return ancestors
    .filter((ancestor) => ts.isTryStatement(ancestor) && containsNode(ancestor.tryBlock, node))
    .some((tryStatement) => tryStatement.finallyBlock && hasAwaitedDisconnect(tryStatement.finallyBlock, receiverName));
}

function verifyFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const displayPath = path.relative(process.cwd(), filePath).replaceAll(path.sep, '/');

  function visit(node, ancestors, resolutionContext) {
    if (isFunctionLikeWithBody(node)) {
      const resolverNames = resolverParameterNames(node);
      const nextResolutionContext = {
        resolverNames,
        resolvedVariables: collectResolvedConnectionVariables(node, resolverNames)
      };

      ts.forEachChild(node, (child) => visit(child, [...ancestors, node], nextResolutionContext));
      return;
    }

    if (ts.isCallExpression(node)) {
      const connectReceiver = isMethodCall(node, 'connect');
      if (connectReceiver && (!ts.isAwaitExpression(node.parent) || node.parent.expression !== node)) {
        errors.push(`${displayPath}:${lineAndColumn(sourceFile, node)} awaits every ${connectReceiver}.connect() call.`);
      }

      if (connectReceiver) {
        const connectionArgument = node.arguments[0];
        if (!connectionArgument || !isResolvedConnectionExpression(connectionArgument, resolutionContext)) {
          errors.push(`${displayPath}:${lineAndColumn(sourceFile, node)} must connect with a value resolved through getConnectionString().`);
        }
      }
    }

    const connectReceiver = isAwaitedMethodCall(node, 'connect');
    if (connectReceiver && !hasMatchingFinally(ancestors, node, connectReceiver)) {
      errors.push(`${displayPath}:${lineAndColumn(sourceFile, node)} must wrap ${connectReceiver}.connect() in a try/finally that awaits ${connectReceiver}.disconnect().`);
    }

    ts.forEachChild(node, (child) => visit(child, [...ancestors, node], resolutionContext));
  }

  visit(sourceFile, [], null);
}

for (const entry of fs.readdirSync(toolsDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
    continue;
  }

  verifyFile(path.join(toolsDirectory, entry.name));
}

if (errors.length > 0) {
  console.error('Connection lifecycle verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Connection lifecycle verification passed.');
