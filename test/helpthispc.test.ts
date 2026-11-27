// Help names the new places: the node switch and the sharing and cluster permissions are on This PC; Network's node tab
// opens it; the menu's Permissions is Chat permissions; the PC status grid is described under Linked PCs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../public/help/', import.meta.url);
const pages = readdirSync(dir).filter(f => f.endsWith('.html')).map(f => [f, readFileSync(new URL(f, dir), 'utf8')] as const);

test('no Help page names the old places', () => {
  for (const [f, s] of pages) {
    assert.doesNotMatch(s, /Enable this PC as a node/, f);
    assert.doesNotMatch(s, /Network, Sharing|Sharing permissions:|Network, the PC, Sharing/, f);
    assert.doesNotMatch(s, /Network, This PC;/, f);
  }
});

test('the pages that say where now say This PC, Chat permissions and the grid', () => {
  const page = (f: string) => pages.find(p => p[0] === f)![1];
  assert.match(page('adding-pc.html'), /then <b>This PC<\/b> \(left panel, under Settings\), turn on <b>Use this PC as a node<\/b>/);
  assert.match(page('network-roles.html'), /its <b>This is a node<\/b> and <b>Backup, model and LLM storage<\/b> tabs open This PC\./);
  assert.match(page('sharing-permissions.html'), /in the My PC window, <b>Permissions<\/b>, <b>Change<\/b> opens them there/);
  assert.match(page('sharing-permissions.html'), /They are not the <b>Chat permissions<\/b> page/);
  assert.match(page('backups.html'), /on that PC, This PC, Sharing and cluster permissions, tick <b>Enable backups<\/b>/);
  assert.match(page('tool-permissions.html'), /<h1>Chat permissions: what a chat may do<\/h1>/);
  assert.match(page('linked-pcs.html'), /starts with a grid of every linked PC: a mark, then its name\./);
  assert.match(page('linked-pcs.html'), /Worker PC \(DESKTOP-1\)/);
  assert.match(readFileSync(new URL('topics.js', dir), 'utf8'), /title: 'Chat permissions: what a chat may do'/);
});
