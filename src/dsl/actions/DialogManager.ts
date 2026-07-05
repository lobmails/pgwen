/**
 * dsl/actions/DialogManager.ts — Per-page dialog queue for pgwen.
 *
 * the reference framework model: accept/dismiss steps come AFTER the trigger action, and the reference framework
 * waits for the dialog to appear.  The pre-registration pattern (registering
 * the handler BEFORE the trigger) is also supported for parity with projects that
 * follow that pattern.
 *
 * This module implements a dialog queue that:
 *  1. Is attached to the lazy page proxy before any steps run.
 *  2. Registers a persistent page.on('dialog', ...) on the real page as soon
 *     as ensurePage() creates it.
 *  3. Buffers incoming dialogs when no intent is registered yet (post-trigger pattern).
 *  4. Satisfies pending intents immediately when a dialog arrives (pre-registration pattern).
 */

import type { DialogLike } from '../locatorUtils';

// ─── Internal types ──────────────────────────────────────────────────────────

interface DialogIntent {
  action: 'accept' | 'dismiss';
  text?: string | undefined;
  resolve: (message: string) => void;
  reject: (err: Error) => void;
}

interface BufferedDialog {
  dialog: DialogLike;
  message: string;
}

// ─── DialogQueue ─────────────────────────────────────────────────────────────

export class DialogQueue {
  private buffered: BufferedDialog[] = [];
  private intents: DialogIntent[] = [];
  private lastMessage = '';
  private shown = false;

  /** Called by the persistent page.on('dialog', ...) handler. */
  handleIncoming(dialog: DialogLike): void {
    const message = dialog.message();
    this.lastMessage = message;
    this.shown = true;

    const intent = this.intents.shift();
    if (intent) {
      const op = intent.action === 'accept'
        ? (intent.text !== undefined ? dialog.accept(intent.text) : dialog.accept())
        : dialog.dismiss();
      op.then(() => intent.resolve(message), intent.reject);
    } else {
      // No one is waiting yet — buffer the dialog
      this.buffered.push({ dialog, message });
    }
  }

  /** Accept the next dialog (immediately if buffered, otherwise waits). */
  async accept(text?: string): Promise<string> {
    const queued = this.buffered.shift();
    if (queued) {
      await (text !== undefined ? queued.dialog.accept(text) : queued.dialog.accept());
      return queued.message;
    }
    return new Promise<string>((resolve, reject) => {
      this.intents.push({ action: 'accept', text, resolve, reject });
    });
  }

  /** Dismiss the next dialog (immediately if buffered, otherwise waits). */
  async dismiss(): Promise<string> {
    const queued = this.buffered.shift();
    if (queued) {
      await queued.dialog.dismiss();
      return queued.message;
    }
    return new Promise<string>((resolve, reject) => {
      this.intents.push({ action: 'dismiss', resolve, reject });
    });
  }

  get lastDialogMessage(): string { return this.lastMessage; }
  get wasShown(): boolean { return this.shown; }
}

// ─── Registry keyed on page proxy ────────────────────────────────────────────

// Using a Map (not WeakMap) because the proxy object may not be GC'd during
// the run.  Entries are removed in detachQueue() when the context closes.
const registry = new Map<object, DialogQueue>();

/** Attach a DialogQueue to a page proxy before any steps run. */
export function attachQueue(proxyPage: object, queue: DialogQueue): void {
  registry.set(proxyPage, queue);
}

/** Remove the queue entry when the browser context closes. */
export function detachQueue(proxyPage: object): void {
  registry.delete(proxyPage);
}

/** Retrieve the DialogQueue for a page proxy (returns undefined if not attached). */
export function getQueue(proxyPage: object): DialogQueue | undefined {
  return registry.get(proxyPage);
}
