/** Progress of an analysis, for long runs: which phase, a message and an overall percentage. */
export type ProgressPhase = 'read' | 'parse' | 'models' | 'verify' | 'analyzers' | 'fixes' | 'llm' | 'confirm' | 'done';

export interface Progress {
    phase: ProgressPhase;
    /** What is happening now, e.g. "Checking model Order.status (3/24)". */
    message: string;
    /** 0 to 100, over the whole analysis. */
    percent: number;
}

export type OnProgress = (progress: Progress) => void;

/** Share of the whole run each phase covers (start, end), in percent. */
export const PHASES: Record<Exclude<ProgressPhase, 'read' | 'done'>, [number, number]> = {
    parse: [0, 20],
    models: [20, 25],
    verify: [25, 50],
    analyzers: [50, 65],
    fixes: [65, 85],
    llm: [85, 92],
    confirm: [92, 99]
};

/** Reports step `i` of `n` within a phase; yields so the report reaches the client before synchronous work. */
export function reporter(onProgress: OnProgress | undefined) {
    return async (phase: keyof typeof PHASES, message: string, i = 0, n = 1): Promise<void> => {
        if (!onProgress) return;
        const [start, end] = PHASES[phase];
        onProgress({ phase, message, percent: Math.round(start + ((end - start) * Math.min(i, n)) / Math.max(n, 1)) });
        await new Promise(resolve => setImmediate(resolve));
    };
}
