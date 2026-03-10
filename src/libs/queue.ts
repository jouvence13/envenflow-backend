export const queue = {
  async add(jobName: string, payload: unknown): Promise<void> {
    // Replace with BullMQ/Cloud Tasks integration.
    // eslint-disable-next-line no-console
    console.log(`Job queued -> ${jobName}`, payload);
  }
};
