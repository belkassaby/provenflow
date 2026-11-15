/**
 * The map of a code base's projects (`pflow c4`, POST /api/c4/discover): the projects around it with
 * the same owner, how they depend on each other, what each is made of, as a C4 model; and where
 * code belongs (placement suggestions). A C4 model the code base already has (`workspace.dsl`) is
 * returned with it, so the editor can open it or merge the discovered projects into it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeC4Workspaces, parseC4Dsl, writeC4Dsl, type C4Workspace } from '@provenflow/language';
import { createContext, type PlacementSuggestion } from './context.js';
import { discoverProjects, linkProjects, shownProjects, type DiscoverOptions, type ProjectInfo, type ProjectLink } from './discover.js';
import { cycles, declaredVersusUsed, outdated, sharedLibraries, versionDrift, type SharedLibrary } from './hygiene.js';
import { buildWorkspace } from './landscape.js';
import { duplicatesAcross, moveToConsumer, moveToDependency } from './placement.js';
import { readSources, type ProjectSources } from './sources.js';

export type { PlacementSuggestion } from './context.js';
export type { DiscoverOptions, ProjectInfo, ProjectLink } from './discover.js';
export type { SharedLibrary } from './hygiene.js';

export interface ProjectMapOptions extends DiscoverOptions {
    /** Read the sources (imports, definitions) for components and placement suggestions (default true). */
    sources?: boolean;
}

export interface ProjectMap {
    root: string;
    focus: string;
    projects: ProjectInfo[];
    links: ProjectLink[];
    libraries: SharedLibrary[];
    suggestions: PlacementSuggestion[];
    workspace: C4Workspace;
    /** The C4 model found in the code base (Structurizr DSL), and the discovered projects merged into it. */
    existing?: { file: string; text: string; merged?: C4Workspace };
    notes: string[];
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;
const CONFIDENCE = { high: 0, medium: 1, low: 2 } as const;

export function mapProjects(dir: string, options: ProjectMapOptions = {}): ProjectMap {
    const root = resolve(dir);
    const all = discoverProjects(root, options);
    const links = linkProjects(all);
    const projects = shownProjects(all, links);
    const focus = projects.find(p => p.focus) ?? all.find(p => p.focus);
    if (!focus) throw new Error(`No project found in ${root}.`);
    if (!projects.includes(focus)) projects.unshift(focus);
    const shownIds = new Set(projects.map(p => p.id));
    const shownLinks = links.filter(l => shownIds.has(l.from) && shownIds.has(l.to));
    const notes: string[] = [];
    const sources = new Map<string, ProjectSources>();
    if (options.sources !== false) {
        for (const p of projects.filter(x => x.owned)) {
            const s = readSources(p);
            if (s.files.length) sources.set(p.id, s);
            if (s.truncated) notes.push(`${p.name}: only the first 4000 source files were read.`);
        }
    }
    const ctx = createContext(projects, shownLinks, sources);
    const libraries = sharedLibraries(ctx);
    const suggestions = [...cycles(ctx), ...outdated(ctx), ...declaredVersusUsed(ctx), ...duplicatesAcross(ctx), ...[...sources.values()].flatMap(s => [...moveToDependency(ctx, s), ...moveToConsumer(ctx, s)]), ...versionDrift(ctx, libraries)].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || CONFIDENCE[a.confidence] - CONFIDENCE[b.confidence]);
    const workspace = buildWorkspace(ctx, focus, libraries);
    const existing = existingModel(root, workspace, notes);
    notes.push(`${projects.length} project(s) shown of ${all.length} found${options.scan?.length ? ` in ${options.scan.join(', ')}` : ''}; ${projects.filter(p => p.owned).length} with the same owner as ${focus.name}.`);
    return { root, focus: focus.id, projects, links: shownLinks, libraries, suggestions, workspace, ...(existing ? { existing } : {}), notes };
}

const MODEL_FILES = ['docs/c4/workspace.dsl', 'docs/architecture/workspace.dsl', 'docs/workspace.dsl', 'architecture/workspace.dsl', 'c4/workspace.dsl', 'workspace.dsl'];

/** The code base's own C4 model, if it has one, and the discovered projects merged into it. */
function existingModel(root: string, discovered: C4Workspace, notes: string[]): ProjectMap['existing'] {
    const file = MODEL_FILES.find(f => existsSync(join(root, f))) ?? dslIn(root, 'docs/c4');
    if (!file) return undefined;
    const text = readFileSync(join(root, file), 'utf8');
    const parsed = parseC4Dsl(text);
    const errors = parsed.diagnostics.filter(d => d.severity === 'error');
    if (errors.length) notes.push(`${file}: ${errors.length} error(s), first on line ${errors[0].line}: ${errors[0].message}`);
    return { file, text, merged: mergeC4Workspaces(parsed.workspace, discovered) };
}

function dslIn(root: string, dir: string): string | undefined {
    try {
        const f = readdirSync(join(root, dir)).find(n => n.endsWith('.dsl'));
        return f ? `${dir}/${f}` : undefined;
    } catch {
        return undefined;
    }
}

/** The map as Markdown: the projects, their links, and the suggestions. */
export function projectMapMarkdown(map: ProjectMap): string {
    const name = (id: string) => map.projects.find(p => p.id === id)?.name ?? id;
    return [
        `# Projects around ${name(map.focus)}`,
        '',
        '| Project | Version | Kind | Owner | Path |',
        '| --- | --- | --- | --- | --- |',
        ...map.projects.map(p => `| ${p.focus ? `**${p.name}**` : p.name} | ${p.version ?? ''} | ${p.ecosystem} ${p.application ? 'application' : 'library'} | ${p.owned ? 'same' : 'other'} | ${p.path} |`),
        '',
        '## Dependencies between them',
        '',
        ...map.links.map(l => linkLine(l, name)),
        '',
        `## Where code belongs (${map.suggestions.length})`,
        '',
        ...map.suggestions.flatMap(s => [`- **${s.severity}** (${s.confidence}) ${s.title}. ${s.detail}`, ...s.files.map(f => `  - ${name(f.project)}: \`${f.file}${f.line ? `:${f.line}` : ''}\``)]),
        '',
        ...map.notes.map(n => `_${n}_`),
        '',
        '```dsl',
        writeC4Dsl(map.workspace).trimEnd(),
        '```',
        ''
    ].join('\n');
}

function linkLine(l: ProjectLink, name: (id: string) => string): string {
    const module = l.fromModule ? ` (${l.fromModule})` : '';
    const kind = l.dependency.kind === 'runtime' ? '' : ` (${l.dependency.kind})`;
    const outside = l.satisfied === false ? ` — local version ${l.version} is outside the range` : '';
    return `- ${name(l.from)}${module} → ${name(l.to)}: ${l.dependency.name} ${l.dependency.range ?? ''}${kind}${outside}`;
}
