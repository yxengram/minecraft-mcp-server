type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isTypedNbt(value: unknown): value is { type: string; value: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value && 'value' in value
    && typeof (value as { type: unknown }).type === 'string';
}

/** Converts network NBT ({ type, value } wrappers) into plain JSON. */
export function simplifyNbt(value: unknown): Json {
  if (isTypedNbt(value)) {
    const inner = value.value;
    if (value.type === 'compound' && typeof inner === 'object' && inner !== null) {
      return Object.fromEntries(Object.entries(inner).map(([key, child]) => [key, simplifyNbt(child)]));
    }
    if (value.type === 'list' && typeof inner === 'object' && inner !== null && 'value' in inner) {
      const list = inner as unknown as { type: string; value: unknown[] };
      const items = list.value ?? [];
      const itemType = list.type;
      return items.map(item => simplifyNbt(isTypedNbt(item) ? item : { type: itemType, value: item }));
    }
    return simplifyNbt(inner);
  }
  if (Array.isArray(value)) return value.map(simplifyNbt);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, simplifyNbt(child)]));
  }
  return value as Json;
}

/** Flattens a chat component (JSON string, NBT or object) into plain text. */
export function componentToText(component: unknown): string {
  if (component === null || component === undefined) return '';
  if (typeof component === 'string') {
    const trimmed = component.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        return componentToText(JSON.parse(trimmed));
      } catch {
        return component;
      }
    }
    return component;
  }
  if (typeof component === 'number' || typeof component === 'boolean') return String(component);
  if (isTypedNbt(component)) return componentToText(simplifyNbt(component));
  if (Array.isArray(component)) return component.map(componentToText).join('');
  if (typeof component === 'object') {
    const node = component as Record<string, unknown>;
    let text = '';
    if (typeof node.text === 'string') text += node.text;
    else if (typeof node[''] === 'string') text += node[''];
    else if (typeof node.translate === 'string') {
      const args = Array.isArray(node.with) ? node.with.map(componentToText) : [];
      text += args.length > 0 ? `${node.translate} (${args.join(', ')})` : node.translate;
    }
    if (Array.isArray(node.extra)) text += node.extra.map(componentToText).join('');
    return text;
  }
  return '';
}
