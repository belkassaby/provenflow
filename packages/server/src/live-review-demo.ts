/** Seeded for the live test of the ProvenFlow review action: a timer that is started twice leaks. */
export class Ticker {
    private timer?: ReturnType<typeof setInterval>;

    start(): void {
        this.timer = setInterval(() => undefined, 1000);
    }

    stop(): void {
        clearInterval(this.timer);
    }
}
