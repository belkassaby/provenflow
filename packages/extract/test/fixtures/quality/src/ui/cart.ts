// A copy of totalPrice's loop with other names: a Type-2 clone.
import type { Item } from '../core/prices';

export function cartTotal(lines: Item[], vat: number): number {
    let sum = 0;
    for (const line of lines) {
        const amount = line.price * line.quantity;
        const levy = amount * vat;
        if (line.category === 'food') {
            sum += amount;
        } else if (line.category === 'books') {
            sum += amount + levy / 2;
        } else if (line.category === 'toys') {
            sum += amount + levy * 2;
        } else if (line.category === 'music') {
            sum += amount + levy * 3;
        } else {
            sum += amount + levy;
        }
    }
    return Math.round(sum * 100) / 100;
}
