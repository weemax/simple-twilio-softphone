// Rough E.164 display helper. No real formatting library in this app.
// +15551234567 → +1 555 123 4567
export function formatNumber(n) {
  if (!n) return '';
  if (n.length <= 4) return n;
  const plus = n.startsWith('+') ? '+' : '';
  const digits = n.replace(/^\+/, '');
  if (digits.length <= 4) return n;
  const cc = digits.slice(0, digits.length - 10);
  const tail = digits.slice(-10);
  const grouped = tail.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  return cc ? `${plus}${cc} ${grouped}` : grouped;
}
