export function resolveItemsByName<T extends { name: string }>(
  items: T[],
  query: string,
  location = 'inventory'
): { items: T[] } | { error: string } {
  const normalized = query.trim().toLowerCase();
  const exact = items.filter(item => item.name === normalized);
  if (exact.length > 0) return { items: exact };

  const partial = items.filter(item => item.name.includes(normalized));
  const names = [...new Set(partial.map(item => item.name))];
  if (names.length === 0) return { error: `Couldn't find any item matching '${query}' in ${location}` };
  if (names.length > 1) return { error: `'${query}' is ambiguous, matches: ${names.join(', ')}. Use the exact name` };
  return { items: partial };
}

export function countItems(items: { count: number }[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}
