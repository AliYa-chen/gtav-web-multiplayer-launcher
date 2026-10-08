export const phases = Object.freeze({ checking: ['识别与校验', 20], engine: ['准备运行引擎', 55], fonts: ['准备游戏字体', 82], ready: ['准备完成', 100] });
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export function displayDirectory(value) { return value || '尚未选择游戏资源目录'; }
export function canLaunch({ selected, busy, desktop }) { return Boolean(selected && !busy && desktop); }
export function progressValue(phase) { return phases[phase]?.[1] || 0; }
