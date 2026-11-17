/** Opens the browser file picker and reads the chosen file as text. */
export function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = async () => {
            const file = input.files?.[0];
            resolve(file ? { name: file.name, text: await file.text() } : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
    });
}

/** A file the editor saves or exports, when the IDE around it writes it (see DesktopBridge). */
export interface SavedFile {
    name: string;
    content: string;
    /** text, or base64 (an image). */
    encoding: 'text' | 'base64';
    type: string;
}

/** Where saved and exported files go instead of a browser download: the IDE the editor is in. */
export class SaveTarget {
    private static target?: (file: SavedFile) => void;

    static set(target: (file: SavedFile) => void): void {
        SaveTarget.target = target;
    }

    /** Hands the file to the IDE; false in a browser (it downloads the file). */
    static save(file: SavedFile): boolean {
        SaveTarget.target?.(file);
        return !!SaveTarget.target;
    }
}

export function downloadText(fileName: string, text: string, type = 'text/plain'): void {
    if (SaveTarget.save({ name: fileName, content: text, encoding: 'text', type })) return;
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads a data: URL (a PNG export), or hands it to the IDE. */
export function downloadDataUrl(fileName: string, dataUrl: string): void {
    const [header, data] = dataUrl.split(',', 2);
    const type = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
    if (header.endsWith(';base64') && SaveTarget.save({ name: fileName, content: data, encoding: 'base64', type })) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    a.click();
}
