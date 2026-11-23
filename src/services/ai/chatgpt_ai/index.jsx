import { chatgptRespond } from '../../../utils/chatgpt';
import { resolveChatGPTModel } from '../../../utils/chatgpt_settings';
import { DEFAULT_SYSTEM_PROMPT } from './prompt';

export { info } from './info';

export { DEFAULT_SYSTEM_PROMPT };

// Same `summarize(text, { config })` contract as the other AI services, but spends the user's
// ChatGPT plan instead of an API key. `config.systemPrompt` is the per-call instruction; an empty
// `config.model` follows the default model shared with the translate service.
export async function summarize(text, options = {}) {
    const { config } = options;
    const output = await chatgptRespond({
        model: await resolveChatGPTModel(config?.model),
        instructions: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        input: [{ role: 'user', content: String(text ?? '') }],
    });
    return output;
}

export * from './Config';
export * from './info';
