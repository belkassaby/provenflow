/**
 * What the ProvenFlow sidebar shows, as plain trees: the findings by kind with their counterexample
 * steps, the extracted models with their false properties, the hotspots and the quality trends.
 * No `vscode` import here: tree-view.ts turns these nodes into VS Code's tree items.
 */
import type { Location, Report, ReportFinding, Severity } from './report';

export interface TreeNode {
    /** Unique within its view, and stable from one analysis to the next (keeps what is expanded). */
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    /** A codicon name: error, warning, info, pass, type-hierarchy... */
    icon?: string;
    /** What the icon's colour says. */
    tone?: Severity | 'ok';
    /** The place in the analysed folder a click opens. */
    place?: Location;
    /** A model a click opens in the ProvenFlow editor (models/<model>.pflow). */
    model?: string;
    /** What the item offers in its context menu (VS Code's `viewItem`). */
    context?: string;
    finding?: ReportFinding;
    children?: TreeNode[];
}

/** The groups of the Findings view, in the report's order. */
const CATEGORIES: Array<[string, string]> = [
    ['security', 'Security and dataflow'],
    ['memory', 'Memory safety and arithmetic'],
    ['heap', 'Heap (interprocedural)'],
    ['build', 'Build and tests'],
    ['dependencies', 'Dependencies'],
    ['state-machine', 'State machines'],
    ['lifecycle', 'Resource lifecycles'],
    ['pattern', 'Design patterns'],
    ['architecture', 'Architecture'],
    ['duplication', 'Duplicated code'],
    ['complexity', 'Complexity'],
    ['tests', 'Tests and coverage'],
    ['paradigm', 'Paradigm and size'],
    ['practice', 'Practices and anti-patterns'],
    ['naming', 'Naming']
];

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];

/** The findings, grouped by kind (the groups with errors first), each with its counterexample steps. */
export function findingNodes(report: Report): TreeNode[] {
    const titles = new Map(CATEGORIES);
    const order = [...titles.keys()];
    const groups = new Map<string, ReportFinding[]>();
    for (const f of report.findings) groups.set(f.category ?? 'other', [...(groups.get(f.category ?? 'other') ?? []), f]);
    const worst = (fs: ReportFinding[]) => Math.min(...fs.map(f => SEVERITY_ORDER.indexOf(f.severity)));
    return [...groups.entries()]
        .sort(([a, fa], [b, fb]) => worst(fa) - worst(fb) || rank(order, a) - rank(order, b))
        .map(([category, fs]) => ({
            id: `category:${category}`,
            label: titles.get(category) ?? category,
            description: String(fs.length),
            icon: SEVERITY_ORDER[worst(fs)],
            tone: SEVERITY_ORDER[worst(fs)],
            children: [...fs].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).map((f, i) => findingNode(f, `${category}:${i}`))
        }));
}

function rank(order: string[], category: string): number {
    const i = order.indexOf(category);
    return i < 0 ? order.length : i;
}

function findingNode(f: ReportFinding, key: string): TreeNode {
    const where = f.loc ? `${f.loc.file}:${f.loc.line}` : f.subject;
    const confirmed = f.confirmation?.status === 'confirmed' ? ' · confirmed on the code' : f.confirmation?.status === 'refuted' ? ' · not reproduced' : '';
    const fix = f.suggestedPatch?.files?.length ? (f.suggestedPatch.verified ? 'fix' : 'unverified-fix') : '';
    const steps = (f.counterexample ?? []).map((step, i) => ({
        id: `${key}:step:${i}`,
        label: `${i}. ${step.event ? `${step.event} → ` : ''}${step.state}`,
        description: step.loc ? `${step.loc.file}:${step.loc.line}` : undefined,
        icon: 'debug-stackframe-dot',
        place: step.loc
    }));
    return {
        id: `finding:${key}:${f.rule}:${where}`,
        label: f.message.split('\n')[0],
        description: `${f.rule} · ${where}${confirmed}`,
        tooltip: [f.message, `Fix: ${f.fix}`, f.spec ? `Property: ${f.spec}` : '', f.confirmation ? `On the code (${f.confirmation.by}): ${f.confirmation.status}. ${f.confirmation.detail}` : ''].filter(Boolean).join('\n\n'),
        icon: f.severity,
        tone: f.severity,
        place: f.loc,
        model: f.model,
        context: ['finding', fix, f.model ? 'model' : ''].filter(Boolean).join(' '),
        finding: f,
        children: steps.length ? steps : undefined
    };
}

/** The models, those with false properties first, each with the properties found false. */
export function modelNodes(report: Report): TreeNode[] {
    const failed = (id: string) => report.verdicts.filter(v => v.model === id && v.verdict === 'false');
    return [...report.models]
        .sort((a, b) => failed(b.id).length - failed(a.id).length || a.id.localeCompare(b.id))
        .map(m => {
            const false_ = failed(m.id);
            const checked = report.verdicts.filter(v => v.model === m.id).length;
            return {
                id: `model:${m.id}`,
                label: m.subject,
                description: false_.length ? `${false_.length} of ${checked} properties false` : `${checked} properties hold`,
                tooltip: `models/${m.id}.pflow (${m.kind})\nClick to open it in the ProvenFlow editor${false_.length ? ' with its counterexamples' : ''}.`,
                icon: 'type-hierarchy-sub',
                tone: false_.length ? 'warning' : 'ok',
                model: m.id,
                context: 'model',
                children: false_.length ? false_.map(v => ({ id: `model:${m.id}:${v.spec}`, label: v.spec, icon: 'close', tone: 'error' as const, model: m.id })) : undefined
            };
        });
}

/** The functions to simplify first: complexity × commits to their file. */
export function hotspotNodes(report: Report): TreeNode[] {
    return report.hotspots.map(h => ({
        id: `hotspot:${h.file}:${h.line}:${h.name}`,
        label: h.name,
        description: h.changes ? `${h.cognitive} × ${h.changes} commits = ${h.score}` : `complexity ${h.cognitive}`,
        tooltip: `${h.file}:${h.line}\nCognitive Complexity ${h.cognitive}${h.changes ? `, its file changed in ${h.changes} commits` : ''}.`,
        icon: 'flame',
        tone: 'warning',
        place: { file: h.file, line: h.line }
    }));
}
