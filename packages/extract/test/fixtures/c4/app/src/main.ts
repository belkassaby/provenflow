import { Panel } from './ui/panel';
import { formatSize } from './util/format';

export function start(): string {
    return new Panel().title() + formatSize(2048);
}
