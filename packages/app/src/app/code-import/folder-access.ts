/**
 * A folder of this computer opened with write access (File System Access API, Chrome/Edge): the
 * browser reads the sources for the analysis and writes the reviewed changes back itself, without
 * sending the folder's location to the server. The handle is kept in IndexedDB so a report restored
 * after a reload can still be applied (the browser asks again for permission).
 */

interface PermissionHandle {
    queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;

/** The folder picker with write access, when the browser has one. */
export function directoryPicker(): DirectoryPicker | undefined {
    const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    return typeof picker === 'function' ? picker.bind(window) : undefined;
}

/** Every file below the folder: relative path -> File, skipping folders `skip` matches. */
export async function listFiles(dir: FileSystemDirectoryHandle, skip: RegExp, prefix = ''): Promise<Array<{ path: string; file: File }>> {
    const out: Array<{ path: string; file: File }> = [];
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            if (!skip.test(`/${path}/`)) out.push(...(await listFiles(handle as FileSystemDirectoryHandle, skip, path)));
        } else {
            out.push({ path, file: await (handle as FileSystemFileHandle).getFile() });
        }
    }
    return out;
}

export async function ensureWritable(dir: FileSystemDirectoryHandle): Promise<boolean> {
    const handle = dir as unknown as PermissionHandle;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function fileHandle(dir: FileSystemDirectoryHandle, path: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    let folder = dir;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create });
    return folder.getFileHandle(parts[parts.length - 1], { create });
}

export async function readText(dir: FileSystemDirectoryHandle, path: string): Promise<string | undefined> {
    try {
        return await (await (await fileHandle(dir, path, false)).getFile()).text();
    } catch {
        return undefined;
    }
}

export async function writeText(dir: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
    const writable = await (await fileHandle(dir, path, true)).createWritable();
    await writable.write(text);
    await writable.close();
}

// ------------------------------------------------------------ persistence

const DB = 'provenflow';
const STORE = 'handles';

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveFolder(dir: FileSystemDirectoryHandle): Promise<void> {
    try {
        const db = await open();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(dir, 'code-folder');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch {
        // No IndexedDB (private window): the folder is kept until the page is reloaded.
    }
}

export async function loadFolder(): Promise<FileSystemDirectoryHandle | undefined> {
    try {
        const db = await open();
        const value = await new Promise<unknown>((resolve, reject) => {
            const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('code-folder');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return value as FileSystemDirectoryHandle | undefined;
    } catch {
        return undefined;
    }
}
