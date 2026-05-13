export class Scheduler {

  private readonly pending =
    new Map<string, string>();

  private scheduled = false;

  private currentFlush:
    Promise<void> | null = null;

  constructor(
    private readonly flush:
    (
      updates: Map<string, string>
    ) => Promise<void>
  ) {}

  async enqueue(
    fileName: string,
    content: string
  ): Promise<void> {

    this.pending.set(
      fileName,
      content
    );

    if (!this.scheduled) {

      this.scheduled = true;

      this.currentFlush =
        Promise.resolve()
          .then(() => this.run());
    }

    await this.currentFlush;
  }

  private async run() {

    this.scheduled = false;

    const batch =
      new Map(this.pending);

    this.pending.clear();

    await this.flush(batch);
  }
}
