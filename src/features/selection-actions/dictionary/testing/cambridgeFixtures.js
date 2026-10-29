// Cambridge pages for the adapter tests, built with the class structure observed on the real
// pages (dictionary.cambridge.org/dictionary/english-chinese-simplified/..., 2026-10-22):
//   .superentry > .di-body > .entry-body__el (word / phrasal verb) | .idiom-block > .di-title
//   .di-title .headword, .pos.dpos, .dpron-i (.region + .pron), .def-block.ddef_block
//   (.ddef_d definition, .def-body > .trans > .dtrans meanings, .examp > .eg + .trans)
// Only the structure is reproduced; the text is neutral test text.
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function senseHtml({ definition, meanings = [], examples = [], pos } = {}) {
    const trans =
        meanings.length > 0
            ? `<span class="trans dtrans dtrans-se break-cj">${meanings.join(';')}${meanings
                  .map((m) => `<span class="dtrans">${esc(m)}</span>`)
                  .join('')}</span>`
            : '';
    const examps = examples
        .map(
            (e) =>
                `<div class="examp dexamp"><span class="eg deg">${esc(e.text)}</span>` +
                (e.translation ? `<span class="trans dtrans dtrans-se hdb break-cj">${esc(e.translation)}</span>` : '') +
                `</div>`
        )
        .join('');
    return (
        `<div class="pr dsense">` +
        (pos ? `<h3 class="dsense_h"><span class="hw dsense_hw">x</span><span class="pos dsense_pos">${esc(pos)}</span></h3>` : '') +
        `<div class="sense-body dsense_b"><div class="def-block ddef_block">` +
        `<div class="ddef_h">${definition ? `<div class="def ddef_d db">${esc(definition)}</div>` : ''}</div>` +
        `<div class="def-body ddef_b">${trans}${examps}</div></div></div></div>`
    );
}

const pronHtml = (prons = []) =>
    prons
        .map(
            (p) =>
                `<span class="${p.region} dpron-i"><span class="region dreg">${esc(p.region)}</span>` +
                `<span class="daud"><audio class="hdn"><source src="/media/x.mp3"></audio></span>` +
                `<span class="pron dpron">${esc(p.ipa)}</span></span>`
        )
        .join('');

export function wordEntry({ headword, pos = 'noun', prons = [], senses = [] }) {
    return (
        `<div class="pr entry-body__el"><div class="pos-header dpos-h"><div class="di-title">` +
        `<span class="headword hdb tw-bw dhw dpos-h_hw"><span class="hw dhw">${esc(headword)}</span></span></div>` +
        `<div class="posgram dpos-g"><span class="pos dpos">${esc(pos)}</span></div>${pronHtml(prons)}</div>` +
        `<div class="pos-body">${senses.map(senseHtml).join('')}</div></div>`
    );
}

export function phrasalEntry({ headword, prons = [], senses = [] }) {
    return (
        `<div class="entry-body__el clrd js-share-holder"><div class="pv-block"><div class="di-title">` +
        `<h2 class="headword tw-bw dhw dpos-h_hw">${esc(headword)}</h2></div><span class="di-info">` +
        `<div class="pos-header dpos-h"><span class="anc-info-head danc-info-head"><span class="pos dpos">phrasal verb</span>` +
        `<span class="hw dhw">base</span></span><span class="pos dpos">verb</span>${pronHtml(prons)}</div></span>` +
        `<span class="pv-body dpv-body">${senses.map(senseHtml).join('')}</span></div></div>`
    );
}

export function idiomBlock({ headword, senses = [] }) {
    return (
        `<div class="pr idiom-block"><div class="idiom-block"><div class="di-title">` +
        `<h2 class="headword tw-bw dhw dpos-h_hw">${esc(headword)}</h2></div>` +
        `<span class="di-info"><span class="pos dpos">idiom</span></span>` +
        `<span class="idiom-body didiom-body">${senses.map(senseHtml).join('')}</span></div></div>`
    );
}

export const entryPage = (title, ...blocks) =>
    `<!doctype html><html><head><title>${esc(title)} in Simplified Chinese - Cambridge Dictionary</title></head><body>` +
    `<div class="pr di superentry"><div class="di-head"><div class="di-title"><h1 class="ti">Translation of ${esc(title)}</h1></div></div>` +
    `<div class="di-body"><div class="entry-body">${blocks.join('')}</div></div></div></body></html>`;

export const notFoundPage = (query) =>
    `<!doctype html><html><head><title>${esc(query)} - Did you spell it correctly? Alternative spellings in the Cambridge English-Chinese (Simplified) Dictionary - Cambridge Dictionary</title></head>` +
    `<body><h1 class="lpb-10 lbb">Your search terms did not match any entries.</h1></body></html>`;

// Not a Cambridge entry page and not its no-match page (e.g. a challenge / changed layout).
export const unrecognizedPage = () =>
    '<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1></body></html>';

// An entry page whose blocks carry no readable definition (markup drift).
export const driftedPage = () =>
    entryPage(
        'drift',
        '<div class="pr entry-body__el"><div class="di-title"><span class="headword">drift</span></div><div class="pos-body"><div class="pr dsense"></div></div></div>'
    );

// Fixture catalogue keyed by lower-cased query, as Cambridge would answer after its redirect.
export const PAGES = {
    resilience: () =>
        entryPage(
            'resilience',
            wordEntry({
                headword: 'resilience',
                pos: 'noun',
                prons: [
                    { region: 'uk', ipa: '/rɪˈzɪl.jəns/' },
                    { region: 'us', ipa: '/rɪˈzɪl.jəns/' },
                ],
                senses: [
                    {
                        pos: 'noun',
                        definition: 'the ability to be happy again after something bad has happened',
                        meanings: ['复原力', '恢复力'],
                        examples: [{ text: 'The resilience of the human psyche.', translation: '人类心理的复原力。' }],
                    },
                    { pos: 'noun', definition: 'the ability of a substance to return to its shape', meanings: ['弹性'] },
                ],
            })
        ),
    'take off': () =>
        entryPage(
            'take-off',
            phrasalEntry({
                headword: 'take something off',
                prons: [{ region: 'uk', ipa: '/teɪk/' }],
                senses: [{ definition: 'to remove something', meanings: ['脱下'] }],
            }),
            phrasalEntry({
                headword: 'take off',
                prons: [{ region: 'uk', ipa: '/teɪk/' }],
                senses: [
                    {
                        definition: 'If an aircraft takes off, it leaves the ground.',
                        meanings: ['起飞', '飞起'],
                        examples: [{ text: 'The plane took off at 8.30.', translation: '飞机8点半起飞。' }],
                    },
                    { definition: 'to suddenly start to be successful', meanings: ['突然成功'] },
                ],
            }),
            wordEntry({
                headword: 'take-off',
                pos: 'noun',
                prons: [{ region: 'uk', ipa: '/ˈteɪk.ɒf/' }],
                senses: [{ pos: 'noun', definition: 'the moment when an aircraft leaves the ground', meanings: ['起飞'] }],
            })
        ),
    'look up': () =>
        entryPage(
            'look-up',
            phrasalEntry({ headword: 'look up', senses: [{ definition: 'to become better', meanings: ['改善'] }] })
        ),
    'break the ice': () =>
        entryPage(
            'break the ice',
            idiomBlock({
                headword: 'break the ice',
                senses: [
                    {
                        definition: 'to make people feel more relaxed with each other',
                        meanings: ['打破冷场'],
                        examples: [{ text: 'We played a game to break the ice.' }],
                    },
                ],
            })
        ),
    // Cambridge answers an unknown phrase with a different, fuzzy-matched entry.
    'the quick': () =>
        entryPage(
            'cut to the quick',
            idiomBlock({ headword: 'cut (someone) to the quick', senses: [{ definition: 'to hurt', meanings: ['伤透'] }] })
        ),
    went: () =>
        entryPage(
            'go',
            wordEntry({
                headword: 'go',
                pos: 'verb',
                prons: [{ region: 'us', ipa: '/ɡoʊ/' }],
                senses: [{ pos: 'verb', definition: 'to move or travel', meanings: ['去'] }],
            })
        ),
    'sparse word': () =>
        entryPage(
            'sparse word',
            wordEntry({ headword: 'sparse word', pos: '', senses: [{ meanings: ['稀疏'] }] })
        ),
    'hostile word': () =>
        entryPage(
            'hostile word',
            wordEntry({
                headword: 'hostile word',
                pos: 'noun',
                senses: [
                    {
                        definition: '<img src=x onerror=alert(1)>',
                        meanings: ['<script>alert(2)</script>'],
                        examples: [{ text: '<b>bold</b>', translation: '<iframe src=//evil></iframe>' }],
                    },
                ],
            })
        ),
    xqzvbnmkw: () => notFoundPage('xqzvbnmkw'),
    captcha: () => unrecognizedPage(),
    drift: () => driftedPage(),
};

// respond() for the browser runner: answers `search/direct` requests from PAGES.
export function cambridgeResponder({ statusFor = {} } = {}) {
    return (url) => {
        const q = new URL(url).searchParams.get('q');
        if (q === null) return null;
        const key = q.toLowerCase();
        if (statusFor[key]) return { status: statusFor[key], body: 'error' };
        const page = PAGES[key];
        return page ? { status: 200, body: page() } : { status: 200, body: notFoundPage(q) };
    };
}
