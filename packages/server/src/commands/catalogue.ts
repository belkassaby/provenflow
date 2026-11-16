/** `pflow catalogue`: the patterns and practices the code checks verify, and which are selected. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOGUE, catalogueMarkdown, loadConfig, selectedPractices, type ProvenflowConfig } from '@provenflow/extract';
import { checksOf, type Values } from './shared.js';

export function catalogueCommand(values: Values, dir = '.'): number {
    const loaded = loadConfig(resolve(dir), values.config);
    const checks = checksOf(values);
    const config: ProvenflowConfig = checks ? { ...loaded, checks: { ...loaded.checks, ...checks } } : loaded;
    const { selected, unknown } = selectedPractices(config);
    const text = values.json ? `${JSON.stringify(CATALOGUE.map(p => ({ ...p, selected: selected.has(p.id) })), null, 2)}\n` : catalogueMarkdown(config);
    if (values.output) {
        writeFileSync(values.output, text);
        console.log(`Wrote ${values.output}: ${CATALOGUE.length} entries, ${selected.size} selected.`);
    } else process.stdout.write(text);
    unknown.forEach(id => console.error(`note: unknown catalogue entry "${id}"`));
    return unknown.length ? 2 : 0;
}
