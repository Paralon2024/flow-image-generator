export default defineContentScript({
  // Keep this as a statically registered MAIN-world content script. The queue
  // injects prompts from the background worker; the interceptor observes the
  // same page requests and forwards media metadata through content.ts.
  matches: ['https://labs.google/*', 'https://flow.google.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    console.log('[FLOW-EXT] Injector running in MAIN world — installing fetch/XHR interceptors');

    const publishIfRelevant = (text: string) => {
      if (!text.trim()) return;

      const publish = (data: unknown) => {
        const serialized = JSON.stringify(data);
        if (!serialized.includes('batchId') && !serialized.includes('mediaId') &&
            !serialized.includes('workflows') && !serialized.includes('generatedImage')) return;
        window.postMessage({ type: 'FLOW_BATCH_RESPONSE', data }, '*');
      };

      try {
        publish(JSON.parse(text));
        return;
      } catch {
        // Some Flow endpoints stream newline-delimited JSON.
      }

      for (const line of text.split('\n').filter(value => value.trim())) {
        try {
          publish(JSON.parse(line));
        } catch {
          // Ignore non-JSON stream fragments.
        }
      }
    };

    const originalFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const request = args[0];
      const url = typeof request === 'string'
        ? request
        : request instanceof Request
          ? request.url
          : String(request ?? '');

      const response = await originalFetch.apply(this, args);
      if (url.includes('/fx/api/trpc/') || url.includes('batchGenerateImages')) {
        response.clone().text().then(publishIfRelevant).catch(error => {
          console.warn('[FLOW-EXT] Could not inspect Flow fetch response:', error);
        });
      }
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as XMLHttpRequest & { _flowUrl?: string })._flowUrl = String(url);
      return originalOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.send = function (...args: any[]) {
      const url = (this as XMLHttpRequest & { _flowUrl?: string })._flowUrl ?? '';
      if (url.includes('/fx/api/trpc/') || url.includes('batchGenerateImages')) {
        this.addEventListener('load', function (this: XMLHttpRequest) {
          if (typeof this.responseText === 'string') publishIfRelevant(this.responseText);
        });
      }
      return originalSend.apply(this, args as [body?: Document | XMLHttpRequestBodyInit | null]);
    };

    console.log('[FLOW-EXT] fetch/XHR interceptors installed');
  },
});
