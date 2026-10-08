import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, canLaunch, progressValue, displayDirectory } from '../src/view-state.js';
test('用户目录内容只作为文字显示，不能注入HTML', () => { assert.equal(escapeHtml('D:/<script>&"\''), 'D:/&lt;script&gt;&amp;&quot;&#39;'); });
test('选目录且桌面后端可用才允许启动，准备期间禁止重入', () => {
  assert.equal(canLaunch({ selected: '/游戏', desktop: true, busy: false }), true);
  for (const field of [{ selected: '' }, { desktop: false }, { busy: true }]) assert.equal(canLaunch({ selected: '/游戏', desktop: true, busy: false, ...field }), false);
});
test('进度阶段按后端步骤呈现，未知阶段不伪造完成', () => { assert.equal(progressValue('ready'), 100); assert.equal(progressValue('unknown'), 0); assert.equal(displayDirectory(''), '尚未选择游戏资源目录'); });
