import { inject, Injectable, signal } from '@angular/core';
import type { Core } from 'cytoscape';
import { DesktopBridge } from './desktop-bridge';

export type Theme = 'light' | 'dark';

/** The theme chosen with the toggle (index.html reads it too, to paint the first frame right). */
const THEME_KEY = 'provenflow.theme';

/**
 * The colour theme of the whole editor: the one chosen with the toggle in the top bar, else the
 * system's. It is set as `<html data-theme>`, which the stylesheet's colour variables follow; the
 * diagrams read those variables, and draw again when the theme changes. In the desktop application
 * the window's own frame and menus follow it too.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
    private readonly desktop = inject(DesktopBridge);
    /** Whether the dark theme is on (else the light one). */
    readonly dark = signal(false);

    constructor() {
        this.apply(savedTheme() ?? systemTheme());
        // The desktop window follows a theme that was chosen; otherwise it follows the system already.
        const saved = savedTheme();
        if (saved) this.desktop.setTheme(saved);
        // In a VS Code tab: VS Code's theme.
        this.desktop.followTheme(theme => this.apply(theme));
        // Until a theme is chosen, follow the system's (it may change with the time of day).
        globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (!savedTheme()) this.apply(systemTheme());
        });
    }

    toggle(): void {
        const next: Theme = this.dark() ? 'light' : 'dark';
        try {
            localStorage.setItem(THEME_KEY, next);
        } catch {
            // Storage unavailable: the choice lasts for this page only.
        }
        this.apply(next);
        this.desktop.setTheme(next);
    }

    /** The attribute first, so that the colour variables have changed when the canvases redraw. */
    private apply(theme: Theme): void {
        document.documentElement.dataset['theme'] = theme;
        this.dark.set(theme === 'dark');
    }
}

function savedTheme(): Theme | undefined {
    try {
        const saved = localStorage.getItem(THEME_KEY);
        return saved === 'light' || saved === 'dark' ? saved : undefined;
    } catch {
        return undefined;
    }
}

function systemTheme(): Theme {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** A colour of the current theme (a variable of styles.css), for the canvases. */
export function themeColour(name: string, fallback: string): string {
    return typeof document === 'undefined' ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Keeps a Cytoscape viewport the size of its element. A canvas created in a tab that is not shown
 * has no size: it is fitted to its content the first time it is shown.
 */
export function followSize(cy: Core, element: HTMLElement): ResizeObserver {
    const observer = new ResizeObserver(() => {
        const hidden = cy.width() === 0 || cy.height() === 0;
        cy.resize();
        if (hidden && cy.width() > 0 && cy.nodes().length > 0) cy.fit(undefined, 40);
    });
    observer.observe(element);
    return observer;
}
