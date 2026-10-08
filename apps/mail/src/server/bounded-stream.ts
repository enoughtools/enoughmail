export class UploadTooLarge extends Error { readonly status = 413; readonly code = 'upload_too_large'; constructor() { super('Upload is too large.'); } }

/** Relay uploads with backpressure and an actual-byte bound, without buffering. */
export function boundedUploadStream(request: Request, limit: number): ReadableStream<Uint8Array> {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new UploadTooLarge();
  const reader = request.body?.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reader) { controller.close(); return; }
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); return; }
        received += next.value.byteLength;
        if (received > limit) { await reader.cancel(); reader.releaseLock(); controller.error(new UploadTooLarge()); return; }
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { if (reader) { await reader.cancel(reason); reader.releaseLock(); } },
  });
}
