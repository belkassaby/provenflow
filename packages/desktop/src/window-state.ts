/** The main window's size, place and theme, kept between runs (in the user data folder). */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Theme = 'light' | 'dark';

export interface WindowState {
    bounds?: Bounds;
    maximized?: boolean;
    /** The editor's theme, last chosen (the window opens in it, before the page has loaded). */
    theme?: Theme;
}

export const DEFAULT_SIZE = { width: 1440, height: 900 };
const MIN_VISIBLE = 120;

export function loadWindowState(file: string): WindowState {
    try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
        return typeof state === 'object' && state ? state : {};
    } catch {
        return {};
    }
}

/** Saves what changed, keeping the rest. */
export function saveWindowState(file: string, state: WindowState): void {
    try {
        writeFileSync(file, JSON.stringify({ ...loadWindowState(file), ...state }));
    } catch {
        // The user data folder is not writable: the next run opens at the default size.
    }
}

/**
 * The saved bounds when enough of the window would be on one of the screens (a screen may have
 * been unplugged since), else nothing: the window then opens at its default size, centred.
 */
export function visibleBounds(saved: Bounds | undefined, screens: Bounds[]): Bounds | undefined {
    if (!saved || saved.width < 200 || saved.height < 150) return undefined;
    const onScreen = screens.some(s => overlap(saved.x, saved.width, s.x, s.width) >= MIN_VISIBLE && overlap(saved.y, saved.height, s.y, s.height) >= MIN_VISIBLE);
    return onScreen ? saved : undefined;
}

function overlap(a: number, aLength: number, b: number, bLength: number): number {
    return Math.min(a + aLength, b + bLength) - Math.max(a, b);
}

/** A theme sent by the page, if it is one. */
export function themeOf(value: unknown): Theme | undefined {
    return value === 'light' || value === 'dark' ? value : undefined;
}

/** The window's colour before the page paints: the editor's background in each theme. */
export const BACKGROUND: Record<Theme, string> = { light: '#eef1f5', dark: '#0f141a' };
