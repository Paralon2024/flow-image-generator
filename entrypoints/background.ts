import { browser } from 'wxt/browser';
import type { QueueItem } from '../utils/types';

const MAX_CONCURRENT = 3;
const IMAGES_PER_SCENE = 2;        // Flow generates this many images per prompt
const INJECT_DELAY_MS = 15_000;    // 15s between injections → max 4 prompts/min = 8 images/min (rate limit)
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60s pause when rate limit error is detected

let queue: QueueItem[] = [];
let downloadedTileIds = new Set<string>();
let isInjecting = false;
let pollingInterval: any = null;
let activeTabId: number | null = null;
let rateLimitCooldownUntil = 0; // timestamp — no new injections before this
let activeGenerationMode: 'agent' | 'standard' = 'standard';
let activeImageModel = 'nano-banana-pro';

// mediaId (= data-tile-id in DOM) → { sceneNumber, imageIndex }
const mediaIdToScene = new Map<string, { sceneNumber: number; imageIndex: number }>();

export default defineBackground(() => {
  console.log('Flow Background Queue Orchestrator Started');

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_QUEUE') {
      sendResponse({ queue });
      return true;
    }

    if (message.type === 'START_QUEUE') {
      const { prompts, tabId } = message;
      activeTabId = tabId;
      activeGenerationMode = message.generationMode === 'agent' ? 'agent' : 'standard';
      activeImageModel = typeof message.imageModel === 'string' ? message.imageModel : 'nano-banana-pro';

      const newItems: QueueItem[] = prompts.map((p: { scene_number: number; prompt: string }) => ({
        id: Math.random().toString(36).substring(2, 9),
        scene_number: p.scene_number,
        prompt: p.prompt,
        status: 'PENDING',
      }));

      queue = [...queue, ...newItems];
      broadcastQueue();
      initializeKnownIdsAndStart(tabId);
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'CLEAR_QUEUE') {
      queue = [];
      mediaIdToScene.clear();
      downloadedTileIds.clear();
      isInitialized = false;
      isInjecting = false;
      rateLimitCooldownUntil = 0;
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      activeTabId = null;
      broadcastQueue();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'BATCH_DETECTED') {
      handleBatchResponse(message.data);
      return true;
    }
  });
});

function unwrapTrpc(raw: any): any {
  // tRPC wraps responses: { result: { data: { json: <actual data> } } } or array of such
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const inner = item?.result?.data?.json ?? item?.result?.data;
      if (inner?.workflows || inner?.media) return inner;
    }
  }
  if (raw?.result?.data?.json?.workflows || raw?.result?.data?.json?.media) return raw.result.data.json;
  if (raw?.result?.data?.workflows || raw?.result?.data?.media) return raw.result.data;
  return raw;
}

function handleBatchResponse(raw: any) {
  try {
    const data = unwrapTrpc(raw);
    const workflows: any[] = data?.workflows ?? [];
    const mediaItems: any[] = data?.media ?? [];

    console.log(`[BATCH] response received — ${workflows.length} workflow(s), ${mediaItems.length} media item(s)`);

    for (const workflow of workflows) {
      const workflowId: string = workflow?.name ?? '(no name)';
      const batchId: string | undefined = workflow?.metadata?.batchId;
      const displayName: string | undefined = workflow?.metadata?.displayName;

      console.log(`[BATCH] workflow: ${workflowId}`);
      console.log(`  batchId:     ${batchId ?? '(none — skipping)'}`);
      console.log(`  displayName: ${displayName ?? '(none)'}`);

      if (!batchId) continue;

      // Log all media items that belong to this workflow
      const batchMedia = mediaItems.filter(
        m => m?.image?.generatedImage?.workflowId === workflowId || m?.workflowId === workflowId
      );
      console.log(`  media matched by workflowId: ${batchMedia.length} / ${mediaItems.length}`);
      batchMedia.forEach((m: any, idx: number) => {
        const mediaId = m?.image?.generatedImage?.mediaId ?? m?.name;
        const textInput = m?.image?.generatedImage?.requestData?.promptInputs?.[0]?.textInput;
        console.log(`    [${idx}] mediaId: ${mediaId}, textInput: "${textInput}"`);
      });

      // Match queue item by full prompt text (textInput is the original prompt, displayName is a short summary)
      const promptFromResponse: string | undefined =
        batchMedia[0]?.image?.generatedImage?.requestData?.promptInputs?.[0]?.textInput
        ?? displayName;

      console.log(`  prompt used for matching: "${promptFromResponse}"`);
      console.log(`  queue IN_PROGRESS items:`, queue.filter(q => q.status === 'IN_PROGRESS').map(q => `scene ${q.scene_number} prompt="${q.prompt.slice(0, 40)}""`));

      // Match only by prompt — a scene can receive multiple batch responses (1 per image)
      const target = promptFromResponse
        ? queue.find(q => q.status === 'IN_PROGRESS' && q.prompt === promptFromResponse)
        : undefined;

      if (!target) {
        console.warn(`  [BATCH] no queue match — prompt "${promptFromResponse?.slice(0, 60)}" not found among IN_PROGRESS items`);
        continue;
      }

      console.log(`  [BATCH] matched → scene ${target.scene_number}`);

      // Count images already mapped for this scene to assign the correct imageIndex
      let nextImageIndex = [...mediaIdToScene.values()]
        .filter(v => v.sceneNumber === target.scene_number).length + 1;

      batchMedia.forEach((m: any) => {
        const mediaId: string | undefined = m?.image?.generatedImage?.mediaId ?? m?.name;
        if (mediaId && !mediaIdToScene.has(mediaId)) {
          mediaIdToScene.set(mediaId, { sceneNumber: target.scene_number, imageIndex: nextImageIndex });
          console.log(`    mapped mediaId ${mediaId} → scene ${target.scene_number} img ${nextImageIndex}`);
          nextImageIndex += 1;
        }
      });
    }

    broadcastQueue();
  } catch (e) {
    console.error('[BATCH] error', e);
  }
}

function broadcastQueue() {
  browser.runtime.sendMessage({ type: 'QUEUE_UPDATED', queue }).catch(() => {});
}

let isInitialized = false;

async function initializeKnownIdsAndStart(tabId: number) {
  if (isInitialized) {
    processQueue();
    startPollingIfNeeded();
    return;
  }
  isInitialized = true;

  try {
    const initialResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Array.from(document.querySelectorAll('flow-image-tile, [data-tile-id]'))
          .map(tile => {
            const img = tile.querySelector('img') as HTMLImageElement | null;
            const src = img?.currentSrc || img?.src;
            if (!src || src.startsWith('data:')) return null;
            return tile.getAttribute('data-media-id') || tile.getAttribute('data-tile-id') || src;
          })
          .filter((id): id is string => Boolean(id)),
    });

    const initialIds = initialResults?.[0]?.result;
    if (Array.isArray(initialIds)) {
      initialIds.forEach((id: string | null) => { if (id) downloadedTileIds.add(id); });
    }
  } catch (e) {
    console.error('[INIT] error', e);
  }

  processQueue();
  startPollingIfNeeded();
}

async function processQueue() {
  if (isInjecting) return;
  if (activeTabId === null) return;

  // Respect rate limit cooldown
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const remaining = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    console.log(`[RATE LIMIT] cooldown active — ${remaining}s remaining`);
    return;
  }

  const inProgressCount = queue.filter(q => q.status === 'IN_PROGRESS').length;
  if (inProgressCount >= MAX_CONCURRENT) return;

  const nextPending = queue.find(q => q.status === 'PENDING' || q.status === 'RATE_LIMITED');
  if (!nextPending) return;

  isInjecting = true;
  nextPending.status = 'IN_PROGRESS';
  broadcastQueue();

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: async (promptText, generationMode, imageModel) => {
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const visible = (el: Element | null): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
        };
        const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
        const closeAgentPanel = async () => {
          const panel = document.querySelector<HTMLElement>('flow-agent-panel');
          if (!panel || !visible(panel)) return;
          const close = panel.querySelector<HTMLButtonElement>(
            "button:has(mat-icon:text-is('right_panel_close')), button:has(mat-icon:text-is('close'))"
          );
          if (!close) throw new Error('Flow Agent side panel is open, but its Close control was not found.');
          close.click();
          for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
            if (!visible(panel)) return;
            await wait(200);
          }
          throw new Error('Flow Agent side panel did not close.');
        };
        const getAgentToggle = () => document.querySelector<HTMLButtonElement>(
          'button.agent-mode-chip, flow-agent-mode-switch button.switch'
        );
        const isPressed = (button: HTMLButtonElement) =>
          button.getAttribute('aria-pressed') === 'true' ||
          button.classList.contains('agent-mode-chip-checked') ||
          button.classList.contains('checked');

        const shouldUseAgent = generationMode === 'agent';
        if (!shouldUseAgent) {
          await closeAgentPanel();
        }

        let agentToggle = getAgentToggle();
        if (agentToggle && isPressed(agentToggle) !== shouldUseAgent) {
          agentToggle.click();
          await wait(800);
        }
        agentToggle = getAgentToggle();

        const agentPanel = document.querySelector<HTMLElement>('flow-agent-panel');
        const agentPanelOpen = !!agentPanel && visible(agentPanel);
        let agentBox = document.querySelector<HTMLElement>('flow-creative-agent-prompt-box');
        if (agentPanelOpen && agentPanel) {
          agentBox = agentPanel.querySelector<HTMLElement>('flow-creative-agent-prompt-box') || agentBox;
        }
        const agentModeActive = agentPanelOpen || (!!agentToggle && isPressed(agentToggle)) ||
          (!!agentBox && !document.querySelector('flow-base-prompt-box, flow-prompt-box'));

        if (shouldUseAgent && !agentModeActive) {
          return { success: false, error: 'Could not activate Google Flow Agent mode. No prompt was submitted.' };
        }
        if (!shouldUseAgent && agentModeActive) {
          return { success: false, error: 'Google Flow is still in Agent mode. Close the Agent panel or switch Agent off, then retry. No prompt was submitted.' };
        }

        let composer: HTMLElement | null = null;
        let editorDom: HTMLElement | null = null;
        for (let elapsed = 0; elapsed < 45_000; elapsed += 1_000) {
          if (shouldUseAgent) {
            composer = document.querySelector<HTMLElement>('flow-creative-agent-prompt-box');
            if (agentPanelOpen && agentPanel) {
              composer = agentPanel.querySelector<HTMLElement>('flow-creative-agent-prompt-box') || composer;
            }
          } else {
            composer = document.querySelector<HTMLElement>('flow-base-prompt-box, flow-prompt-box');
          }
          editorDom = composer?.querySelector<HTMLElement>(
            '.prosemirror-editor [role="textbox"][contenteditable="true"].ProseMirror'
          ) ?? composer?.querySelector<HTMLElement>(
            'div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"][aria-label="Describe your goal"]'
          ) ?? null;
          if (composer && editorDom && visible(editorDom)) break;
          await wait(1_000);
        }

        if (!composer || !editorDom || !visible(editorDom)) {
          return {
            success: false,
            error: shouldUseAgent
              ? 'Google Flow Agent prompt box is not ready. Open a project and wait until the Agent prompt editor is visible.'
              : 'Google Flow project is not ready. Open a project and wait until the standard prompt editor is visible.',
          };
        }

        if (!shouldUseAgent) {
          const settingsButton = composer.querySelector<HTMLButtonElement>(
            'button.settings-trigger-button'
          ) ?? document.querySelector<HTMLButtonElement>('button.settings-trigger-button');
          if (!settingsButton) {
            return { success: false, error: 'Could not find Flow prompt settings. No prompt was submitted.' };
          }
          settingsButton.click();
          await wait(500);
          const settingsPanel = document.querySelector<HTMLElement>(
            'flow-prompt-box-settings, flow-settings-view'
          );
          if (!settingsPanel) {
            return { success: false, error: 'Flow prompt settings did not open. No prompt was submitted.' };
          }
          const imageToggle = Array.from(settingsPanel.querySelectorAll<HTMLElement>('mat-button-toggle'))
            .find(toggle => toggle.querySelector('mat-icon')?.textContent?.trim() === 'image');
          if (imageToggle && !imageToggle.classList.contains('mat-button-toggle-checked')) {
            imageToggle.querySelector<HTMLButtonElement>('button')?.click();
            await wait(300);
          }
          const modelNames: Record<string, string[]> = {
            'nano-banana-pro': ['Nano Banana Pro'],
            // Some Flow accounts still label the same model "Nano Banana 2".
            'nano-banana-2': ['Nano Banana 2.1', 'Nano Banana 2'],
            'nano-banana-2-lite': ['Nano Banana 2 Lite'],
          };
          const requestedModels = modelNames[imageModel] || modelNames['nano-banana-pro'];
          const requestedModel = requestedModels[0];
          const modelTrigger = settingsPanel.querySelector<HTMLButtonElement>(
            'button:has(span.model-select-trigger-content), button.image-model-picker-button'
          );
          if (!modelTrigger) {
            return { success: false, error: 'Could not find the Nano Banana model selector in Flow settings.' };
          }
          const activeModel = normalize(modelTrigger.textContent || '');
          if (!activeModel.toLowerCase().includes(requestedModel.toLowerCase())) {
            modelTrigger.click();
            await wait(350);
            const modelOptions = Array.from(document.querySelectorAll<HTMLElement>(
              '[role="menuitem"], flow-radio-group label.radio-option'
            ));
            const modelOption = modelOptions.find(option => {
              const label = normalize(option.textContent || '').toLowerCase();
              return requestedModels.some(name => label.includes(name.toLowerCase())) &&
                !(imageModel === 'nano-banana-2' && label.includes('lite'));
            });
            if (!modelOption) {
              return { success: false, error: requestedModel + ' is not available in this Google Flow account or could not be found in the model menu.' };
            }
            modelOption.click();
            await wait(500);
          }
          const refreshedSettings = document.querySelector<HTMLElement>(
            'flow-prompt-box-settings, flow-settings-view'
          );
          const selectedTrigger = refreshedSettings?.querySelector<HTMLButtonElement>(
              'button:has(span.model-select-trigger-content), button.image-model-picker-button'
            );
            const selectedModel = normalize(selectedTrigger?.textContent || '');
          if (!requestedModels.some(name => selectedModel.toLowerCase().includes(name.toLowerCase()))) {
            return { success: false, error: 'Google Flow did not confirm the selected model (' + requestedModels.join(' / ') + '). No prompt was submitted.' };
          }
        }

        // Do not modify ProseMirror with synthetic beforeinput/input events.
        // The worker will focus this editor and insert text using trusted CDP input.
        editorDom.focus();
        const editorRect = editorDom.getBoundingClientRect();
        if (editorRect.width <= 0 || editorRect.height <= 0) {
          return { success: false, error: 'Flow prompt editor has no visible clickable area.' };
        }

        return {
          success: true,
          awaitingTrustedInput: true,
          editorPoint: {
            x: editorRect.left + editorRect.width / 2,
            y: editorRect.top + editorRect.height / 2,
          },
        };      },
      args: [nextPending.prompt, activeGenerationMode, activeImageModel],
    });

    const injectionResult = injectionResults?.[0]?.result as
      | { success?: boolean; error?: string; awaitingTrustedInput?: boolean; editorPoint?: { x: number; y: number } }
      | undefined;

    if (!injectionResult?.success) {
      throw new Error(
        injectionResult?.error ?? 'Google Flow prompt submission could not be confirmed.'
      );
    }

    if (!injectionResult.awaitingTrustedInput || !injectionResult.editorPoint) {
      throw new Error('Flow did not return a valid prompt-editor target.');
    }

    const submitTabId = activeTabId;
    if (submitTabId === null) throw new Error('The Google Flow tab is no longer available.');
    const debuggee: chrome.debugger.Debuggee = { tabId: submitTabId };
    let debuggerAttached = false;
    let debuggerStep = 'chrome.debugger.attach';
    try {
      console.log('[CDP] attaching debugger to Flow tab', submitTabId);
      await chrome.debugger.attach(debuggee, '1.3');
      debuggerAttached = true;

      const editorPoint = injectionResult.editorPoint;
      debuggerStep = 'trusted click on prompt editor';
      console.log('[CDP] focusing prompt editor', editorPoint);
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: editorPoint.x, y: editorPoint.y,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: editorPoint.x, y: editorPoint.y,
        button: 'left', clickCount: 1,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: editorPoint.x, y: editorPoint.y,
        button: 'left', clickCount: 1,
      });

      debuggerStep = 'trusted Ctrl+A in prompt editor';
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Control', code: 'ControlLeft',
        windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Control', code: 'ControlLeft',
        windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
      });

      debuggerStep = 'trusted Input.insertText';
      console.log('[CDP] inserting prompt through trusted keyboard input');
      await chrome.debugger.sendCommand(debuggee, 'Input.insertText', {
        text: nextPending.prompt,
      });

      debuggerStep = 'wait for Flow to enable submit';
      const readyResults = await chrome.scripting.executeScript({
        target: { tabId: submitTabId },
        world: 'MAIN',
        func: async (promptText, generationMode) => {
          const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          const normalize = (value: string) => value.replace(/\\s+/g, ' ').trim();
          const shouldUseAgent = generationMode === 'agent';
          const composerSelectors = shouldUseAgent
            ? ['flow-creative-agent-prompt-box']
            : ['flow-base-prompt-box', 'flow-prompt-box'];
          const editorSelectors = shouldUseAgent
            ? ['.prosemirror-editor [role="textbox"][contenteditable="true"].ProseMirror', 'div.ProseMirror[contenteditable="true"]', '[role="textbox"][contenteditable="true"]']
            : ['.prosemirror-editor [role="textbox"][contenteditable="true"].ProseMirror', 'div.ProseMirror[contenteditable="true"]', '[role="textbox"][contenteditable="true"][aria-label="What do you want to create?"]', '[role="textbox"][aria-multiline="true"][contenteditable="true"]', '[role="textbox"][contenteditable="true"][aria-label="Describe your goal"]'];
          const selectors = shouldUseAgent
            ? ["button:has(mat-icon:text-is('arrow_forward'))", 'flow-generate-icon-button button', 'button[aria-label="Send"]', 'button[aria-label="Generate image"]']
            : ['button[aria-label="Start generation"]', 'flow-generate-icon-button button'];
          const expected = normalize(promptText);
          const findCurrentElements = () => {
            let currentComposer: HTMLElement | null = null;
            for (const selector of composerSelectors) {
              currentComposer = document.querySelector<HTMLElement>(selector);
              if (currentComposer) break;
            }
            let currentEditor: HTMLElement | null = null;
            for (const selector of editorSelectors) {
              currentEditor = currentComposer?.querySelector<HTMLElement>(selector) ?? null;
              if (currentEditor) break;
            }
            if (!currentEditor && !shouldUseAgent) {
              currentEditor = document.querySelector<HTMLElement>(
                '[role="textbox"][contenteditable="true"][aria-label="What do you want to create?"]'
              ) ?? document.querySelector<HTMLElement>(
                '[role="textbox"][aria-multiline="true"][contenteditable="true"]'
              );
            }
            return { currentComposer, currentEditor };
          };

          for (let elapsed = 0; elapsed < 20_000; elapsed += 250) {
            // Angular may replace the ProseMirror node after input; never inspect a stale node.
            const { currentComposer, currentEditor } = findCurrentElements();
            const actual = normalize(currentEditor?.innerText || currentEditor?.textContent || '');
            let button: HTMLButtonElement | null = null;
            for (const selector of selectors) {
              const candidate = currentComposer?.querySelector<HTMLButtonElement>(selector)
                ?? document.querySelector<HTMLButtonElement>(selector);
              if (candidate && candidate.getClientRects().length > 0) {
                button = candidate;
                break;
              }
            }
            if (expected && actual.includes(expected) && button &&
                !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
              const rect = button.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { success: true, clickPoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
              }
            }
            await wait(250);
          }

          const { currentComposer: finalComposer, currentEditor: finalEditor } = findCurrentElements();
          const finalText = normalize(finalEditor?.innerText || finalEditor?.textContent || '');
          let finalButton: HTMLButtonElement | null = null;
          for (const selector of selectors) {
            const candidate = finalComposer?.querySelector<HTMLButtonElement>(selector)
              ?? document.querySelector<HTMLButtonElement>(selector);
            if (candidate && candidate.getClientRects().length > 0) {
              finalButton = candidate;
              break;
            }
          }
          const active = document.activeElement as HTMLElement | null;
          return {
            success: false,
            error: 'Flow did not enable its submit button after trusted keyboard input. ' +
              'promptVisible=' + String(!!expected && finalText.includes(expected)) +
              ', editorFound=' + String(!!finalEditor) +
              ', editorConnected=' + String(finalEditor?.isConnected ?? false) +
              ', editorLabel=' + String(finalEditor?.getAttribute('aria-label') ?? 'missing') +
              ', editorText=' + JSON.stringify(finalText.slice(0, 180)) +
              ', activeElement=' + String(active?.tagName ?? 'none') +
              ', activeLabel=' + String(active?.getAttribute('aria-label') ?? 'missing') +
              ', composerFound=' + String(!!finalComposer) +
              ', disabled=' + String(finalButton?.disabled ?? 'button-not-found') +
              ', ariaDisabled=' + String(finalButton?.getAttribute('aria-disabled') ?? 'missing'),
          };
        },
        args: [nextPending.prompt, activeGenerationMode],
      });

      const ready = readyResults?.[0]?.result as
        | { success?: boolean; error?: string; clickPoint?: { x: number; y: number } }
        | undefined;
      if (!ready?.success || !ready.clickPoint) {
        throw new Error(ready?.error ?? 'Flow did not confirm that the prompt is ready to submit.');
      }

      debuggerStep = 'trusted click on Flow submit button';
      const submitPoint = ready.clickPoint;
      console.log('[CDP] submit button is enabled; dispatching trusted click', submitPoint);
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: submitPoint.x, y: submitPoint.y,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: submitPoint.x, y: submitPoint.y,
        button: 'left', clickCount: 1,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: submitPoint.x, y: submitPoint.y,
        button: 'left', clickCount: 1,
      });
    } catch (error: any) {
      const details = {
        name: error?.name ?? null,
        message: error?.message ?? String(error),
        code: error?.code ?? null,
        data: error?.data ?? null,
        stack: error?.stack ?? null,
      };
      console.error('[CDP] trusted input/click failed at ' + debuggerStep, details);
      throw new Error(
        'Trusted input/click failed at ' + debuggerStep + ': ' + JSON.stringify(details)
      );
    } finally {
      if (debuggerAttached) {
        await chrome.debugger.detach(debuggee).catch(() => {});
      }
    }

    console.log(
      `[INJECT] scene ${nextPending.scene_number}: trusted keyboard input and submit click dispatched to Flow`
    );

    // Keep generations sequential to avoid duplicate requests and Flow rate limits.
    await new Promise(r => setTimeout(r, INJECT_DELAY_MS));
  } catch (e) {
    console.error('[INJECT] error', e);
    nextPending.status = 'ERROR';
  } finally {
    isInjecting = false;
    broadcastQueue();
    // Do NOT call processQueue() here — next injection happens only after
    // the current scene's images are confirmed downloaded in the UI (DOWNLOADED status)
  }
}

function startPollingIfNeeded() {
  if (pollingInterval) return;
  if (activeTabId === null) return;

  pollingInterval = setInterval(async () => {
    const inProgressCount = queue.filter(q => q.status === 'IN_PROGRESS').length;
    if (inProgressCount === 0) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      return;
    }

    if (activeTabId === null) return;

    try {
      const scanResults = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => {
          const tiles: [string, string][] = [];
          const rateLimitTileIds: string[] = [];

          document.querySelectorAll('flow-image-tile, [data-tile-id]').forEach(t => {
            const img = t.querySelector('img') as HTMLImageElement | null;
            const rawUrl = img?.currentSrc || img?.src;
            const id = t.getAttribute('data-media-id') || t.getAttribute('data-tile-id') || rawUrl;
            if (!id) return;

            if (rawUrl && !rawUrl.startsWith('data:')) {
              tiles.push([id, rawUrl.startsWith('/') ? location.origin + rawUrl : rawUrl]);
              return;
            }

            // Detect rate limit error tiles — look for the error text (robust vs obfuscated class names)
            if (t.textContent?.includes('too quickly')) {
              rateLimitTileIds.push(id);
            }
          });

          return { tiles, rateLimitTileIds };
        },
      });

      const scanResult = scanResults?.[0]?.result;
      if (!scanResult || !Array.isArray(scanResult.tiles) || !Array.isArray(scanResult.rateLimitTileIds)) {
        console.warn('[POLL] Flow tab returned no tile scan result.');
        return;
      }
      const { tiles: currentTiles, rateLimitTileIds } = scanResult as {
        tiles: [string, string][];
        rateLimitTileIds: string[];
      };

      // Handle rate limit errors
      if (rateLimitTileIds.length > 0) {
        console.warn(`[RATE LIMIT] detected ${rateLimitTileIds.length} failed tile(s) — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
        rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;

        // Mark affected IN_PROGRESS scenes as RATE_LIMITED so they re-enter the queue after cooldown
        const affectedScenes = queue.filter(q => q.status === 'IN_PROGRESS');
        affectedScenes.forEach(q => {
          q.status = 'RATE_LIMITED';
          console.log(`[RATE LIMIT] scene ${q.scene_number} marked as RATE_LIMITED — will retry after cooldown`);
        });

        broadcastQueue();

        // Schedule processQueue to run after cooldown expires
        setTimeout(() => {
          queue.filter(q => q.status === 'RATE_LIMITED').forEach(q => {
            q.status = 'PENDING';
          });
          broadcastQueue();
          processQueue();
        }, RATE_LIMIT_COOLDOWN_MS);
      }

      const newTiles = currentTiles.filter(([id, imgUrl]) => {
        if (downloadedTileIds.has(id)) return false;
        const uuid = imgUrl.match(/[?&]name=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
        if (uuid && downloadedTileIds.has(uuid)) return false;
        return true;
      });

      for (const [tileId, imgUrl] of newTiles) {
        const uuidFromUrl = imgUrl.match(/[?&]name=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];

        // Guard: another tile earlier in this same loop may have already claimed this uuid
        if (downloadedTileIds.has(tileId)) continue;
        if (uuidFromUrl && downloadedTileIds.has(uuidFromUrl)) continue;

        // Flow may expose the generated media ID as the tile ID rather than the URL UUID.
        const mapping = (uuidFromUrl ? mediaIdToScene.get(uuidFromUrl) : undefined)
          ?? mediaIdToScene.get(tileId);

        if (!mapping) {
          console.log(`[POLL] tile ${tileId} | imgSrc: ${imgUrl.slice(0, 100)} | urlUuid: ${uuidFromUrl ?? 'none'} | no mapping yet, waiting`);
          continue;
        }

        downloadedTileIds.add(tileId);
        if (uuidFromUrl) downloadedTileIds.add(uuidFromUrl); // needed for checkSceneComplete lookup
        const paddedScene = mapping.sceneNumber.toString().padStart(2, '0');

        browser.downloads.download({
          url: imgUrl,
          filename: `Flow_Generations/Escena_${paddedScene}/imagen_${mapping.imageIndex}.png`,
          saveAs: false,
        }).catch(err => console.error('[DOWNLOAD] error', err));

        console.log(`[DOWNLOAD] scene ${mapping.sceneNumber} img ${mapping.imageIndex} (tileId: ${tileId} | urlUuid: ${uuidFromUrl})`);

        const sceneItem = queue.find(q => q.scene_number === mapping.sceneNumber && q.status === 'IN_PROGRESS');
        if (sceneItem) {
          const sceneMediaIds = [...mediaIdToScene.entries()]
            .filter(([, v]) => v.sceneNumber === mapping.sceneNumber)
            .map(([k]) => k);

          if (sceneMediaIds.length >= IMAGES_PER_SCENE && sceneMediaIds.every(mid => downloadedTileIds.has(mid))) {
            sceneItem.status = 'DOWNLOADED';
            broadcastQueue();
            processQueue();
          }
        }
      }
    } catch (e) {
      console.error('[POLL] error', e);
    }
  }, 3000);
}
