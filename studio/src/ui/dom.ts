/**
 * Tiny DOM helpers.
 *
 * Every one of these writes text through `textContent`. Names and tags in an
 * Atlas dataset came from an OSM file and are untrusted; nothing in Studio ever
 * assigns them to `innerHTML`.
 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Atlas Studio could not find the #${id} element`);
  }
  return node as T;
}

/** A term/value pair inside a `<dl>`. */
export function appendRow(list: HTMLElement, term: string, value: string, title?: string): void {
  const dt = element('dt', 'row-term', term);
  const dd = element('dd', 'row-value', value);
  if (title !== undefined) {
    dd.title = title;
  }
  list.append(dt, dd);
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${formatNumber(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatMillis(value: number): string {
  return `${value < 10 ? value.toFixed(3) : value.toFixed(1)} ms`;
}
