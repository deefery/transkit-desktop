import { invoke } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';

import { createStreamFetch } from './stream_fetch_core';

/** `fetch` for streaming responses through the native `http_stream` command; see stream_fetch_core.js. */
export const streamFetch = createStreamFetch({
    invoke,
    // Events are emitted to the calling window only.
    listen: (event, handler) => appWindow.listen(event, handler),
});
