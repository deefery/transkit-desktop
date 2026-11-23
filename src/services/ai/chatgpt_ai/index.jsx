import { chatgptRespond } from '../../../utils/chatgpt';

export { info } from './info';

export const DEFAULT_SYSTEM_PROMPT =
    'You are a professional translation assistant. Synthesize the provided translations into one clear, accurate, and natural result. Output only the final translation without explanation.';

// Same `summarize(text, { config })` contract as the other AI services, but spends the user's
// ChatGPT plan instead of an API key. `config.systemPrompt` is the per-call instruction.
export async function summarize(text, options = {}) {
    const { config } = options;
    const output = await chatgptRespond({
        model: config?.model ?? '',
        instructions: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        input: [{ role: 'user', content: String(text ?? '') }],
    });
    return output;
}

export * from './Config';
export * from './info';
