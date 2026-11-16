// Re-implements formatAmount (core/format.ts) instead of importing it.
import pad from 'left-pad-ultra';

export function showAmount(value: number, currency: string, locale: string): string {
    const rounded = Math.round(value * 100) / 100;
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
    const parts = rounded.toFixed(2).split('.');
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? ' ' : ',');
    const text = `${symbol}${whole}${locale === 'fr' ? ',' : '.'}${parts[1]}`;
    return pad(text, 12);
}

export function parse_order_line(line: string): string[] {
    return line.split(';');
}

export function renderCart(): string {
    return 'cart';
}

export function renderTotal(): string {
    return 'total';
}
