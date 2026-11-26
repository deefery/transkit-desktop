import React from 'react';

// Translation services (and third-party plugins) return example sentences as small HTML
// fragments, typically `<b>word</b>` highlighting. They are display text, not markup to trust, so
// the fragment is rebuilt as React elements instead of being set as innerHTML: only the
// formatting tags below survive, every attribute is dropped, other elements are unwrapped to their
// text, and executable / embedded content is removed together with its children.
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'mark', 'sup', 'sub', 'small', 'span', 'br']);
const DROPPED_TAGS = new Set([
    'script',
    'style',
    'template',
    'noscript',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'svg',
    'math',
    'head',
    'title',
    'textarea',
    'select',
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function convertChildren(node, keyPrefix) {
    const out = [];
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    children.forEach((child, index) => {
        const converted = convertNode(child, `${keyPrefix}.${index}`);
        if (Array.isArray(converted)) out.push(...converted);
        else if (converted !== null) out.push(converted);
    });
    return out;
}

function convertNode(node, key) {
    if (node.nodeType === TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== ELEMENT_NODE) return null; // comments, processing instructions
    const tag = String(node.nodeName).toLowerCase();
    if (DROPPED_TAGS.has(tag)) return null;
    if (tag === 'br') return React.createElement('br', { key });
    const children = convertChildren(node, key);
    if (!ALLOWED_TAGS.has(tag)) return children;
    return React.createElement(tag, { key }, ...children);
}

/** Converts a parsed DOM node's children into safe React nodes. Exported for tests. */
export function domToSafeReact(root) {
    return convertChildren(root, 'h');
}

/**
 * Parses an untrusted HTML fragment and returns React nodes that keep only basic text formatting.
 * The DOMParser document is inert: nothing in it runs or loads while it is inspected.
 */
export function safeHtmlToReact(html) {
    if (html === null || html === undefined) return [];
    const text = String(html);
    if (typeof DOMParser === 'undefined') return [text];
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return domToSafeReact(doc.body);
}
