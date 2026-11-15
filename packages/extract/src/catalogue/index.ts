/**
 * The patterns and practices catalogue: what the code checker verifies, as entries a user can read
 * and select. Each finding of a rule an entry owns is tagged with that entry (`finding.practice`);
 * entries left out of the selection (provenflow.config.json `checks`, or the editor's selection)
 * drop their findings, pattern instances and models. Rules no entry owns (security, state machines,
 * dependencies, analysers) are not affected.
 */
import type { ProvenflowConfig } from '../config.js';
import type { ExtractedModel, Finding } from '../models.js';
import type { PatternInstance } from '../patterns.js';
import { PRACTICE_KIND_TITLES } from '@provenflow/language';
import { PATTERNS_CATALOGUE } from './entries.js';
import type { Practice, PracticeKind } from './types.js';

export type { Practice, PracticeKind } from './types.js';
export const CATALOGUE: readonly Practice[] = PATTERNS_CATALOGUE;


/** Entry of each rule (`rule` or `category:rule`). */
const BY_RULE = new Map(CATALOGUE.flatMap(p => p.rules.map(r => [r, p.id] as const)));

/** The catalogue entry a finding is about: its own tag, its rule, or the pattern its model checks. */
export function practiceOf(f: Pick<Finding, 'rule' | 'category' | 'model' | 'practice'>): string | undefined {
    if (f.practice) return f.practice;
    const byRule = BY_RULE.get(`${f.category}:${f.rule}`) ?? BY_RULE.get(f.rule);
    if (byRule) return byRule;
    const pattern = /^pattern-([a-z]+)-/.exec(f.model ?? '')?.[1];
    return pattern && CATALOGUE.some(p => p.id === pattern) ? pattern : undefined;
}

/** The ids selected by the config: `checks.select` (or the default selection), less `checks.skip`. Unknown ids are reported. */
export function selectedPractices(config: ProvenflowConfig): { selected: Set<string>; unknown: string[] } {
    const known = new Set(CATALOGUE.map(p => p.id));
    const select = config.checks?.select ?? CATALOGUE.filter(p => p.selected).map(p => p.id);
    const skip = new Set(config.checks?.skip ?? []);
    const unknown = [...select, ...skip].filter(id => !known.has(id));
    return { selected: new Set(select.filter(id => known.has(id) && !skip.has(id))), unknown: [...new Set(unknown)] };
}

/** Tags each finding with its entry and keeps those of selected entries, and every finding no entry owns. */
export function selectFindings(findings: Finding[], config: ProvenflowConfig): Finding[] {
    const { selected } = selectedPractices(config);
    return findings
        .map(f => {
            const practice = practiceOf(f);
            return practice && !f.practice ? { ...f, practice } : f;
        })
        .filter(f => f.practice === undefined || selected.has(f.practice));
}

/** A pattern analysis without the instances (and their models) of design patterns left out of the selection. */
export function selectPatterns<T extends { models: ExtractedModel[]; instances?: PatternInstance[]; facades?: PatternInstance[] }>(result: T, config: ProvenflowConfig): T {
    const { selected } = selectedPractices(config);
    const all = [...(result.instances ?? []), ...(result.facades ?? [])];
    const dropped = new Set(all.filter(i => !selected.has(i.pattern)).map(i => i.model).filter((m): m is string => !!m));
    const keep = (list: PatternInstance[] | undefined) => list?.filter(i => selected.has(i.pattern));
    return { ...result, instances: keep(result.instances), facades: keep(result.facades), models: result.models.filter(m => !dropped.has(m.id)) } as T;
}

/** A note when the config's `checks` names entries the catalogue does not have. */
export function selectionNotes(config: ProvenflowConfig): string[] {
    const { unknown } = selectedPractices(config);
    return unknown.length ? [`provenflow.config.json "checks" names unknown catalogue entries: ${unknown.join(', ')} (pflow catalogue lists them).`] : [];
}

/** The catalogue as Markdown: one section per kind, each entry in the same narrative form. */
export function catalogueMarkdown(config: ProvenflowConfig = {}): string {
    const { selected } = selectedPractices(config);
    const out = [
        '# Patterns and practices',
        '',
        'What `pflow extract` and the editor\'s Code base review check, entry by entry. Select entries with `checks` in provenflow.config.json (`"select"` replaces the default selection, `"skip"` removes entries), or in the editor under **Import code base → Patterns and practices**. Each entry follows the form of Martin Fowler\'s [Writing Software Patterns](https://martinfowler.com/articles/writingPatterns.html): the solution first, the problem, when to use it and when not to, and an example.',
        '',
        '| Entry | Kind | Rules | Default |',
        '| --- | --- | --- | --- |',
        ...CATALOGUE.map(p => `| [${p.name}](#${anchor(p.name)}) | ${p.kind} | ${p.rules.map(r => `\`${r.replace(/^\w+:/, '')}\``).join(', ')} | ${selected.has(p.id) ? 'on' : 'off'} |`)
    ];
    for (const kind of Object.keys(PRACTICE_KIND_TITLES) as PracticeKind[]) {
        out.push('', `## ${PRACTICE_KIND_TITLES[kind]}`);
        for (const p of CATALOGUE.filter(x => x.kind === kind)) out.push('', ...entryMarkdown(p));
    }
    return `${out.join('\n')}\n`;
}

function entryMarkdown(p: Practice): string[] {
    const fence = (text: string) => ['```' + (p.example.file.endsWith('.py') ? 'python' : 'ts'), text.trimEnd(), '```'];
    const sources = p.sources.map(s => `${s.url ? `[${s.title}](${s.url})` : s.title}, ${s.where}`);
    const related = p.related.map(id => CATALOGUE.find(x => x.id === id)).filter((x): x is Practice => !!x);
    return [
        `### ${p.name}`,
        '',
        `\`${p.id}\` · **${p.summary}**`,
        '',
        p.problem,
        '',
        `**How it works.** ${p.solution}`,
        '',
        `**${p.kind === 'anti-pattern' ? 'When it is reported' : 'When to use it'}.** ${p.use}`,
        '',
        `**${p.kind === 'anti-pattern' ? 'When it is acceptable' : 'When not to'}.** ${p.avoid}`,
        '',
        'Before:',
        '',
        ...fence(p.example.before),
        '',
        'After:',
        '',
        ...fence(p.example.after),
        '',
        `**What ProvenFlow checks.** ${p.checks} Rules: ${p.rules.map(r => `\`${r.replace(/^\w+:/, '')}\``).join(', ')}.${p.autoFix ? ` Automatic fix: ${p.autoFix}` : ''}`,
        '',
        `**Sources.** ${sources.join('; ')}.${related.length ? ` Related: ${related.map(r => `[${r.name}](#${anchor(r.name)})`).join(', ')}.` : ''}`
    ];
}

/** GitHub's heading anchor. */
function anchor(heading: string): string {
    return heading
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s/g, '-');
}
