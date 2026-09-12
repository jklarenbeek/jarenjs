import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

function graph(entry) {
  const visited = new Set(), dependencies = new Set();
  function visit(url) {
    if (visited.has(url.href) || !url.pathname.endsWith('.js')) return;
    visited.add(url.href);
    const ast = parse(readFileSync(url, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
      const specifier = node.source.value;
      assert.ok(!specifier.includes('website'), `private host import: ${specifier}`);
      if (specifier.startsWith('.')) visit(new URL(specifier, url));
      else dependencies.add(specifier);
    }
  }
  visit(new URL(import.meta.resolve(entry)));
  return { visited, dependencies };
}

it('all public editor and host graphs contain only generic Jaren dependencies', () => {
  for (const entry of ['component', 'flow', 'data', 'data/host']) {
    const { dependencies } = graph(`@jarenjs/studio/${entry}`);
    for (const dependency of dependencies) {
      assert.ok(dependency.startsWith('@jarenjs/'), `${entry}: ${dependency}`);
      assert.ok(!dependency.startsWith('@jarenjs/ai'), `${entry}: ${dependency}`);
      assert.ok(!dependency.endsWith('/author'), `${entry}: ${dependency}`);
    }
  }
});

it('the Studio root cannot reach editor rendering or application runtime', () => {
  const { visited, dependencies } = graph('@jarenjs/studio');
  assert.ok([...visited].every(path => !path.includes('/component/')));
  for (const dependency of dependencies) {
    assert.ok(!dependency.startsWith('@jarenjs/view') && !dependency.startsWith('@jarenjs/forms'));
    assert.notEqual(dependency, '@jarenjs/app');
    assert.notEqual(dependency, '@jarenjs/studio/component');
  }
});
