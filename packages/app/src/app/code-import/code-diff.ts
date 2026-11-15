import { Component, ElementRef, OnDestroy, afterNextRender, effect, input, untracked, viewChild } from '@angular/core';
import { LanguageDescription, syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { pflowHighlight, pflowLanguage } from '../text-editor/pflow-language';

/** Loaded languages, by name: each grammar is fetched once, the first time a file needs it. */
const loaded = new Map<string, Promise<LanguageSupport>>();

/** Syntax of a file from its name (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R...). */
export function languageFor(file: string): Promise<LanguageSupport | undefined> {
    // Angular component templates and a few extensions language-data names differently.
    const name = file.replace(/\.(mts|cts)$/, '.ts').replace(/\.gradle$/, '.groovy').replace(/\.kts$/, '.kt').replace(/\.sc$/, '.scala');
    const description = LanguageDescription.matchFilename(languages, name) ?? (/\.[Rr]$/.test(name) ? LanguageDescription.matchLanguageName(languages, 'R') : null);
    if (!description) return Promise.resolve(undefined);
    let support = loaded.get(description.name);
    if (!support) {
        support = description.load();
        loaded.set(description.name, support);
    }
    return support.catch(() => undefined as unknown as LanguageSupport);
}

/**
 * Original code on the left, proposed code on the right, side by side, with the changed lines
 * and characters highlighted. The right side can be edited before applying.
 */
@Component({
    selector: 'app-code-diff',
    template: `
        <div class="code-diff-heads"><span>{{ leftTitle() }}</span><span>{{ rightTitle() }}</span></div>
        <div #host class="code-diff" [class.compact]="compact()"></div>
    `
})
export class CodeDiff implements OnDestroy {
    readonly before = input.required<string>();
    readonly after = input.required<string>();
    /** File name: chooses the syntax highlighting. */
    readonly file = input('');
    readonly leftTitle = input('Original');
    readonly rightTitle = input('Proposed (editable)');
    /** Whether the right side can be edited. */
    readonly editable = input(true);
    /** As tall as the texts (up to a limit), for short examples. */
    readonly compact = input(false);
    private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
    private view?: MergeView;

    constructor() {
        afterNextRender(() => void this.create());
        // Another file or change: rebuild with its texts and language.
        effect(() => {
            const before = this.before();
            const after = this.after();
            const file = this.file();
            untracked(() => {
                if (this.view) void this.create(before, after, file);
            });
        });
    }

    /** The proposed text, with the edits made in the right pane. */
    current(): string {
        return this.view?.b.state.doc.toString() ?? this.after();
    }

    private generation = 0;

    private async create(before = this.before(), after = this.after(), file = this.file()): Promise<void> {
        const generation = ++this.generation;
        const pflow = file.endsWith('.pflow');
        const language = pflow ? undefined : await languageFor(file);
        if (generation !== this.generation) return; // a newer file was asked for meanwhile
        this.view?.destroy();
        // Token classes (tok-keyword, tok-string...) coloured in styles.css, for light and dark themes.
        const common = [lineNumbers(), EditorView.lineWrapping, ...(pflow ? [pflowLanguage, pflowHighlight] : [syntaxHighlighting(classHighlighter), ...(language ? [language] : [])])];
        this.view = new MergeView({
            a: { doc: before, extensions: [...common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
            b: { doc: after, extensions: this.editable() ? common : [...common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
            parent: this.host().nativeElement,
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: { margin: 4, minSize: 8 }
        });
        // Show the first change.
        const first = this.view.chunks[0];
        if (first) this.view.b.dispatch({ effects: EditorView.scrollIntoView(first.fromB, { y: 'center' }) });
    }

    ngOnDestroy(): void {
        this.view?.destroy();
    }
}
