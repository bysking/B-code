import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/app.js';
import { AppController, type CapabilityItem } from '../src/ui/controller.js';
import type { ClipboardImage } from '../src/utils/clipboard.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('probe slash up', async () => {
  const ctrl = new AppController();
  const frame = render(React.createElement(App, {
    ctrl,
    onSubmit: (_t: string | { text: string; images?: ClipboardImage[] }) => {},
    onInterrupt: () => {}, onExit: () => {}, onSetMode: () => {},
    initialOutput: undefined,
  }));
  const { BUILTIN_SLASH_ITEMS } = await import('../src/ui/slash.js');
  ctrl.setSlashItems([...BUILTIN_SLASH_ITEMS, { name: 'zzz-last', description: '最后一项' }]);
  ctrl.openSlash('');
  await wait(400);
  console.log('PROBE init:', strip(frame.lastFrame()??'').split('\n').filter(l=>l.includes('/16')||l.includes('/15')).map(l=>l.trim()));
  frame.stdin.write('\x1b[A');
  await wait(400);
  const f = strip(frame.lastFrame()??'');
  console.log('PROBE after:', f.split('\n').filter(l=>l.includes('/16')).map(l=>l.trim()));
  console.log('PROBE zzz:', f.includes('zzz-last'));
  frame.cleanup();
});
