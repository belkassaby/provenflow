// Seeded for the quality checks: a block copied into ui/cart.ts, and a function too complex and too deeply nested.
import { round } from 'lodash';

export interface Item {
    price: number;
    quantity: number;
    category: string;
}

export function totalPrice(items: Item[], taxRate: number): number {
    let total = 0;
    for (const item of items) {
        const gross = item.price * item.quantity;
        const tax = gross * taxRate;
        if (item.category === 'food') {
            total += gross;
        } else if (item.category === 'books') {
            total += gross + tax / 2;
        } else if (item.category === 'toys') {
            total += gross + tax * 2;
        } else if (item.category === 'music') {
            total += gross + tax * 3;
        } else {
            total += gross + tax;
        }
    }
    return round(total, 2);
}

export function applyDiscounts(items: Item[], member: boolean, coupon?: string): number {
    let discount = 0;
    for (const item of items) {
        if (item.quantity > 0) {
            if (member) {
                for (let i = 0; i < item.quantity; i++) {
                    if (item.category === 'food' && i > 2) {
                        if (coupon && coupon.startsWith('FOOD')) {
                            discount += item.price * 0.2;
                        } else {
                            discount += item.price * 0.1;
                        }
                    }
                }
            } else if (coupon) {
                discount += item.category === 'books' ? 1 : 0.5;
            }
        }
    }
    return discount;
}
