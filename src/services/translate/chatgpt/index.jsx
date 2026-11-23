import { chatgptRespond, fillPlaceholders, splitPromptList } from '../../../utils/chatgpt';
import { Language } from './info';
import { defaultPromptList } from './prompt';

// Translate with the user's ChatGPT plan (no API key). All credentials stay in the Rust side.
export async function translate(text, from, to, options) {
    const { config = {}, setResult, detect } = options;

    const values = { text, from, to, detect: Language[detect] ?? '' };
    const promptList = (config.promptList ?? defaultPromptList).map((item) => ({
        ...item,
        content: fillPlaceholders(item.content ?? '', values),
    }));
    const { instructions, input } = splitPromptList(promptList);

    const streaming = Boolean(config.stream) && typeof setResult === 'function';
    let partial = '';
    const output = await chatgptRespond({
        model: config.model,
        instructions,
        input,
        onDelta: streaming
            ? (delta) => {
                  partial += delta;
                  setResult(partial + '_');
              }
            : undefined,
    });

    let target = output.trim();
    if (target.startsWith('"')) target = target.slice(1);
    if (target.endsWith('"')) target = target.slice(0, -1);
    target = target.trim();
    if (target === '') throw new Error('ChatGPT returned an empty translation.');
    if (streaming) setResult(target);
    return target;
}

export * from './Config';
export * from './info';
