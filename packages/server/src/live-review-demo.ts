/** Seeded for the live test of the ProvenFlow review action: a timer that is started twice leaks. */
export class Ticker {
    private timer?: ReturnType<typeof setInterval>;

    start(): void {
        clearInterval(this.timer); // release the previous one before acquiring again
        this.timer = setInterval(() => undefined, 1000);
    }

    stop(): void {
        clearInterval(this.timer);
    }

    /** Releases what the object holds (added by pflow: it was lost when the object was discarded). */
    dispose(): void {
        clearInterval(this.timer);
    }
}
