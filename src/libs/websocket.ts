export const websocket = {
  emit(channel: string, payload: unknown): void {
    // Replace with Socket.IO or ws integration.
    // eslint-disable-next-line no-console
    console.log(`WS emit -> ${channel}`, payload);
  }
};
