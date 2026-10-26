// Dictated text and field contents are private, so logs show only their
// length. Set UTTER_DEBUG=1 to log the text itself while debugging.
const DEBUG = process.env.UTTER_DEBUG === '1';

export function redact(text: string | undefined | null): string {
  const value = text ?? '';
  return DEBUG ? `"${value}"` : `<${value.length} chars>`;
}
