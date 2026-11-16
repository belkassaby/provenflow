export function formatAmount(value: number, currency: string, locale: string): string {
    const rounded = Math.round(value * 100) / 100;
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
    const parts = rounded.toFixed(2).split('.');
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? ' ' : ',');
    const cents = parts[1];
    return `${symbol}${whole}${locale === 'fr' ? ',' : '.'}${cents}`;
}

export function parseAmount(text: string): number {
    return Number(text.replace(/[^0-9.]/g, ''));
}
