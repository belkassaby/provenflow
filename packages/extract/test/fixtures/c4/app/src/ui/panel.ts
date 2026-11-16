import { Canvas, appOnly } from '@acme/viz';

export class Panel {
    private readonly canvas = new Canvas();
    title(): string {
        return `panel ${this.canvas.width} ${appOnly()}`;
    }
}
