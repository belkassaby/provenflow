import { draw } from '@acme/render';

export class Canvas {
    readonly width = 640;
    paint(): void {
        draw(this.width);
    }
}
