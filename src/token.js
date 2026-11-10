/**
 * The decision model's token, from the page to the worker, outside MCP, as geo-query-wasm's
 * sendSecrets() sends S3 keys: the model never sees it, and it is not in the worker's URL.
 *
 *   await sendToken(worker, key);
 */
export const TOKEN_MESSAGE = 'text-query-wasm/token';
let next = 0;
export function sendToken(worker, token) {
    const id = ++next;
    return new Promise((resolve) => {
        const on = (e) => { if (e.data?.type === TOKEN_MESSAGE && e.data.id === id) { worker.removeEventListener('message', on); resolve(); } };
        worker.addEventListener('message', on);
        worker.postMessage({ type: TOKEN_MESSAGE, id, token });
    });
}
