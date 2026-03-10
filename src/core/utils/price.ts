export function toMoney(value: number | string): string {
  return Number(value || 0).toFixed(2);
}
