// 三个窗口（笔记本、弹窗、截屏）共用：只暴露一个收发消息的口子
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bn', {
  call: msg => ipcRenderer.invoke('bn', msg),
  on: (channel, fn) => { if (/^(ov|cap|nb):/.test(channel)) ipcRenderer.on(channel, (e, ...args) => fn(...args)); }
});
