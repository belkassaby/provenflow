export interface Country {
    zone(): string;
}
export interface Address {
    country: Country;
}
export interface Customer {
    address: Address;
}
export interface Order {
    customer: Customer;
    total: number;
}

export function shippingZone(order: Order): string {
    return order.customer.address.country.zone();
}

export function loadSettings(text: string): Record<string, string> {
    let settings: Record<string, string> = {};
    try {
        settings = JSON.parse(text) as Record<string, string>;
    } catch {}
    return settings;
}

export function cleanup(remove: () => void): void {
    try {
        remove();
    } catch {
        // The file may already be gone: nothing to clean up.
    }
}

export function total(items: number[]): number {
    // const tax = items.length * 0.2;
    // return items.reduce((a, b) => a + b, 0) + tax;
    return items.reduce((a, b) => a + b, 0);
}

export function render(page: string, compact: boolean): string {
    return compact ? page.trim() : `<main>${page}</main>`;
}

export function setVisible(visible: boolean): boolean {
    return visible;
}

export function sessionExpired(started: number, now: number): boolean {
    const limit = 1800000;
    return now - started > limit || now - started > 86400;
}
