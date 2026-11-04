import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/app.js';
import { AppController, type CapabilityItem } from '../src/ui/controller.js';
const strip=(s:string)=>s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('重连后按键仍可处理', async () => {
  const ctrl = new AppController();
  const items: CapabilityItem[] = [
    {name:'a',enabled:true,detail:'x',connected:true},
    {name:'b',enabled:true,detail:'y',connected:true},
  ];
  ctrl.openCapability('mcp', items);
  let reconnects = 0;
  const frame = render(React.createElement(App, {
    ctrl, onSubmit:()=>{}, onInterrupt:()=>{}, onExit:()=>{}, onSetMode:()=>{},
    onReconnectCapability: (n) => {
      reconnects++;
      ctrl.setCapabilityNotice(n, '重连中…');
      setTimeout(() => {
        ctrl.setCapabilityNotice(n, '✓ 已重连');
        ctrl.setCapabilityItems([...items]);
      }, 100);
    },
    onToggleCapability: (n) => {
      const cur = ctrl.capabilityPanel!.items.map(i => i.name === n ? {...i, enabled: !i.enabled} : i);
      ctrl.setCapabilityItems(cur);
    },
    initialOutput: undefined,
  }));
  await wait(150);

  // 按 R 重连
  frame.stdin.write('r'); await wait(300);
  console.log('reconnects =', reconnects);
  assert.equal(reconnects, 1, 'R 触发重连');

  // 重连后 ↓ 应该能移动
  frame.stdin.write('\x1b[B'); await wait(150);
  let f = strip(frame.lastFrame()??'');
  const selAfterDown = f.split('\n').find(l=>l.includes('❯'))?.trim();
  console.log('↓ 后选中:', selAfterDown);
  assert.ok(selAfterDown?.includes('b'), '重连后 ↓ 仍能移动光标');

  // 空格应能切换
  frame.stdin.write(' '); await wait(150);
  f = strip(frame.lastFrame()??'');
  console.log('空格后:', f.split('\n').filter(l=>l.includes('☐')||l.includes('☑')).map(l=>l.trim()));
  // Esc 应能关闭
  frame.stdin.write('\x1b'); await wait(150);
  console.log('Esc 后面板还在?', !!ctrl.capabilityPanel);
  assert.equal(ctrl.capabilityPanel, null, 'Esc 能关闭面板');
  frame.cleanup();
});
