import { ParentFrameHost } from './host-frame';

describe('ParentFrameHost (the editor in an IDE tab)', () => {
    let frame: HTMLIFrameElement;
    let parent: Window;
    let sent: unknown[];

    beforeEach(() => {
        frame = document.createElement('iframe');
        document.body.appendChild(frame);
        parent = frame.contentWindow!;
        sent = [];
        parent.postMessage = ((message: unknown) => sent.push(message)) as Window['postMessage'];
    });
    afterEach(() => frame.remove());

    const fromParent = (data: unknown, source: Window = parent) => window.dispatchEvent(new MessageEvent('message', { data, source }));

    it('takes commands, files, folders to map and the theme from its parent only', () => {
        const host = new ParentFrameHost(parent, window);
        const got: unknown[] = [];
        host.onCommand(c => got.push(['command', c]));
        host.onOpenFile(f => got.push(['file', f.name, f.check]));
        host.onMapC4(p => got.push(['c4', p]));
        host.onTheme(t => got.push(['theme', t]));
        fromParent({ provenflow: 'command', command: 'check' });
        fromParent({ provenflow: 'open-file', file: { name: 'a.pflow', path: '/w/a.pflow', text: '', kind: 'diagram', check: true } });
        fromParent({ provenflow: 'map-c4', path: '/w' });
        fromParent({ provenflow: 'theme', theme: 'dark' });
        fromParent({ provenflow: 'command', command: 'save' }, window);
        fromParent('not a message');
        expect(got).toEqual([
            ['command', 'check'],
            ['file', 'a.pflow', true],
            ['c4', '/w'],
            ['theme', 'dark']
        ]);
    });

    it('says when it listens, and asks its parent for a folder', async () => {
        const host = new ParentFrameHost(parent, window);
        host.ready();
        const picked = host.pickFolder('Code base');
        expect(sent).toEqual([{ provenflow: 'ready' }, { provenflow: 'pick-folder', id: 1, title: 'Code base' }]);
        fromParent({ provenflow: 'folder', id: 1, path: '/w/app' });
        expect(await picked).toBe('/w/app');
    });

    it('is there only in a frame opened with ?host=vscode or ?host=jetbrains', () => {
        expect(new ParentFrameHost(parent, window, 'jetbrains').platform).toBe('jetbrains');
        expect(ParentFrameHost.fromPage(window)).toBeUndefined();
    });
});
