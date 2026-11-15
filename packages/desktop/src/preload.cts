/**
 * The bridge between the editor (a sandboxed page) and the desktop application: menu commands and
 * files to open come in, a folder picker goes out. Nothing else of Node or Electron is exposed.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface OpenedFile {
    name: string;
    path: string;
    text: string;
    kind: 'diagram' | 'c4';
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, value: T) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.off(channel, listener);
    };
}

contextBridge.exposeInMainWorld('provenflowDesktop', {
    platform: process.platform,
    onCommand: (callback: (command: string) => void) => subscribe('provenflow:command', callback),
    onOpenFile: (callback: (file: OpenedFile) => void) => subscribe('provenflow:open-file', callback),
    /** The editor listens: files waiting since the start can come. */
    ready: () => ipcRenderer.send('provenflow:ready'),
    pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke('provenflow:pick-folder', title)
});
