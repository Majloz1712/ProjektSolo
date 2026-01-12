export function sanitizeNullableString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

export function sanitizeRequiredString(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length ? s : '';
}
