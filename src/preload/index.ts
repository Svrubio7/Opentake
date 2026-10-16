import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const ok = (channel: string) => channel.startsWith("take:");

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ok(channel)) throw new Error(`blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel: string, ...args: unknown[]) => {
    if (ok(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    if (!ok(channel)) throw new Error(`blocked channel ${channel}`);
    const fn = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, fn);
    return () => { ipcRenderer.removeListener(channel, fn); };
  },
};

contextBridge.exposeInMainWorld("take", api);
export type TakeApi = typeof api;
