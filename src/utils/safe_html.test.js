// Run with: node --test src/utils/safe_html.test.js
// The sentence-HTML sanitizer used by the Translate window. Node has no HTML parser here, so these
// cases feed hand-built DOM-shaped trees to the production converter; safe_html.browser.test.js
// runs the same production code against the real DOMParser in headless Edge/Chrome.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { domToSafeReact, safeHtmlToReact } from './safe_html.js';

const text = (value) => ({ nodeType: 3, nodeValue: value });
const el = (name, children = [], attributes = {}) => ({ nodeType: 1, nodeName: name.toUpperCase(), attributes, childNodes: children });
const comment = (value) => ({ nodeType: 8, nodeValue: value });
const render = (root) => renderToStaticMarkup(React.createElement('div', null, ...domToSafeReact(root)));

describe('domToSafeReact', () => {
    test('keeps allowed formatting tags and text', () => {
        const root = el('body', [text('a '), el('b', [text('bold')]), text(' and '), el('em', [text('it')]), el('br')]);
        assert.equal(render(root), '<div>a <b>bold</b> and <em>it</em><br/></div>');
    });

    test('drops every attribute, including event handlers and styles', () => {
        const root = el('body', [el('b', [text('x')], { onclick: 'alert(1)', style: 'color:red', class: 'k' })]);
        assert.equal(render(root), '<div><b>x</b></div>');
    });

    test('unwraps unknown elements to their text and drops links and images', () => {
        const root = el('body', [
            el('a', [text('link')], { href: 'javascript:alert(1)' }),
            el('img', [], { src: 'x', onerror: 'alert(1)' }),
            el('div', [el('p', [text('para')])]),
        ]);
        assert.equal(render(root), '<div>linkpara</div>');
    });

    test('removes executable and embedded content with its children', () => {
        const root = el('body', [
            el('script', [text('alert(1)')]),
            el('style', [text('*{}')]),
            el('iframe', [text('frame')]),
            el('svg', [el('b', [text('inside svg')])]),
            comment('note'),
            text('kept'),
        ]);
        assert.equal(render(root), '<div>kept</div>');
    });

    test('text is escaped by React, never interpreted as markup', () => {
        const root = el('body', [text('<img src=x onerror=alert(1)>')]);
        assert.equal(render(root), '<div>&lt;img src=x onerror=alert(1)&gt;</div>');
    });
});

describe('safeHtmlToReact without a DOM parser', () => {
    test('returns the input as plain text', () => {
        assert.equal(typeof globalThis.DOMParser, 'undefined');
        const html = renderToStaticMarkup(React.createElement('span', null, ...safeHtmlToReact('<b onclick="x">w</b>')));
        assert.equal(html, '<span>&lt;b onclick=&quot;x&quot;&gt;w&lt;/b&gt;</span>');
    });

    test('accepts null, undefined and non-strings', () => {
        assert.deepEqual(safeHtmlToReact(null), []);
        assert.deepEqual(safeHtmlToReact(undefined), []);
        assert.deepEqual(safeHtmlToReact(42), ['42']);
    });
});
