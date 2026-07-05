/**
 * Scope.ts — Layered key-value store for pgwen runtime state.
 *
 * Four layers (innermost wins during lookup):
 *   stepdef  → parameters passed into a StepDef invocation
 *   scenario → reset per scenario (or shared per feature depending on state.level)
 *   feature  → shared across all scenarios in one feature run
 *   global   → settings, env vars, implicit pgwen.* values — never reset
 *
 * Binding kinds:
 *   literal  → plain string, stored and returned as-is
 *   lazy     → a resolver function, called every time the value is needed
 *   locator  → a typed locator function, retrieved separately via getLocator()
 */

export type ScopeLayerName = 'global' | 'feature' | 'scenario' | 'stepdef' | 'settings';

export type LazyResolver = () => string | Promise<string>;

// Locator functions are typed loosely here so that the engine layer has no
// compile-time dependency on Playwright types. The DSL layer casts as needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocatorFn = (...args: any[]) => any;

type LiteralEntry = { kind: 'literal'; value: string; masked: boolean };
type LazyEntry    = { kind: 'lazy';    resolver: LazyResolver; masked: boolean };
type LocatorEntry = { kind: 'locator'; fn: LocatorFn };

type BindingEntry = LiteralEntry | LazyEntry | LocatorEntry;

interface ScopeFrame {
  layer: ScopeLayerName;
  bindings: Map<string, BindingEntry>;
}

export interface SetOptions {
  masked?: boolean;
}

/** A single scope binding recorded during write-capture (for HTML report attachments). */
export interface CapturedBinding {
  name: string;
  value: string;
  masked: boolean;
}

export class Scope {
  private readonly frames: ScopeFrame[];
  private readonly readonlyKeys: Set<string> = new Set();

  /**
   * Nested write-capture buffers.
   * Each call to startCapture() pushes a new buffer. Every scope write (set,
   * setTransparent, etc.) appends to ALL active buffers so that each capture
   * level sees the full set of writes in its subtree — matching the reference framework's
   * per-step "Attachments" dropdown which shows all bindings created recursively
   * through a step's StepDef body.
   */
  private readonly _captureBuffers: CapturedBinding[][] = [];

  constructor() {
    // Global frame is always present at index 0
    this.frames = [{ layer: 'global', bindings: new Map() }];
  }

  // ─── Write-capture ───────────────────────────────────────────────────────

  /**
   * Begin capturing scope writes into a new buffer.
   * Nested calls push additional buffers; every write appends to ALL active
   * buffers so that both parent and child steps see their full subtrees.
   */
  startCapture(): void {
    this._captureBuffers.push([]);
  }

  /**
   * Stop capturing and return all writes recorded since the matching
   * startCapture() call. Each write is a {name, value, masked} record.
   */
  stopCapture(): CapturedBinding[] {
    return this._captureBuffers.pop() ?? [];
  }

  /**
   * Append a binding write event to every active capture buffer.
   * Skips pgwen.* system keys — those are never shown as step attachments.
   */
  private _recordCapture(name: string, value: string, masked: boolean): void {
    if (name.startsWith('pgwen.')) return;
    if (this._captureBuffers.length === 0) return;
    const entry: CapturedBinding = { name, value: masked ? '*****' : value, masked };
    for (const buf of this._captureBuffers) {
      buf.push(entry);
    }
  }

  // ─── Frame management ────────────────────────────────────────────────────

  /**
   * Push a new scope layer onto the stack.
   * Call this when entering a feature, scenario, or StepDef.
   */
  push(layer: Exclude<ScopeLayerName, 'global'>): void {
    this.frames.push({ layer, bindings: new Map() });
  }

  /**
   * Pop the innermost frame. Throws if the global frame would be removed.
   */
  pop(): ScopeLayerName {
    if (this.frames.length <= 1) {
      throw new Error('Cannot pop the global scope frame');
    }
    const frame = this.frames.pop();
    return frame!.layer;
  }

  /**
   * Return a snapshot of lazy bindings (name → resolver reference) in the nearest
   * non-stepdef frame. Used by Compositor to implement @Eager: before a step runs,
   * capture this snapshot; after the step, compare — any key whose resolver reference
   * changed (new binding OR re-bound by the same step) is force-evaluated.
   *
   * Uses the enclosing non-stepdef frame rather than the raw current frame so that
   * @Eager correctly detects lazy bindings created via setLazyTransparent() when
   * called from within a StepDef body.
   */
  lazyResolversInNonStepdefFrame(): Map<string, LazyResolver> {
    const snapshot = new Map<string, LazyResolver>();
    for (const [name, entry] of this.enclosingNonStepdefFrame().bindings) {
      if (entry.kind === 'lazy') snapshot.set(name, entry.resolver);
    }
    return snapshot;
  }

  /** @deprecated Use lazyResolversInNonStepdefFrame() */
  lazyKeysInCurrentFrame(): Set<string> {
    const keys = new Set<string>();
    for (const [name] of this.lazyResolversInNonStepdefFrame()) keys.add(name);
    return keys;
  }

  /**
   * Remove a single binding (by name) from every frame that holds it.
   * Used by callers that need to roll back a transient scope set — e.g.
   * inline-annotation flags set for the duration of a single step.
   */
  clearKey(name: string): void {
    for (const frame of this.frames) {
      frame.bindings.delete(name);
    }
    this.readonlyKeys.delete(name);
  }

  /**
   * Remove all bindings from every frame belonging to the given layer name.
   * Useful for resetting scenario state without restructuring the frame stack.
   */
  clear(layer: ScopeLayerName): void {
    for (const frame of this.frames) {
      if (frame.layer === layer) {
        frame.bindings.clear();
      }
    }
  }

  /**
   * Return the name of the innermost (active) layer.
   */
  get currentLayer(): ScopeLayerName {
    return this.frames[this.frames.length - 1]!.layer;
  }

  // ─── Writing bindings ────────────────────────────────────────────────────

  /**
   * Set a literal (eager-resolved) string binding in the current frame.
   * Silently skips if the key was declared read-only via setReadonly().
   */
  set(name: string, value: string, opts: SetOptions = {}): void {
    if (this.readonlyKeys.has(name)) return;
    const masked = opts.masked ?? false;
    this.currentFrame.bindings.set(name, { kind: 'literal', value, masked });
    this._recordCapture(name, value, masked);
  }

  /**
   * Set a StepDef parameter binding in the current (stepdef) frame.
   * Identical to set() but does NOT record into capture buffers — StepDef param
   * bindings are internal substitution details and must not appear as scope
   * attachments on the outer calling step's HTML report row.
   */
  setParam(name: string, value: string): void {
    this.currentFrame.bindings.set(name, { kind: 'literal', value, masked: false });
    // Deliberately no _recordCapture() call.
  }

  /**
   * Set a literal binding in the nearest non-stepdef frame (transparent write).
   * Silently skips if the key was declared read-only via setReadonlyTransparent().
   *
   * the reference framework WebDriver-style parity: bindings written by `<name> is "<value>"` inside a
   * StepDef body must survive scope.pop() and be visible to subsequent steps in
   * the same scenario. This method writes past any active stepdef frames so the
   * binding lands in the enclosing scenario (or feature/global) scope.
   *
   * When no stepdef frame is active the call is identical to set().
   */
  setTransparent(name: string, value: string, opts: SetOptions = {}): void {
    if (this.readonlyKeys.has(name)) return;
    const masked = opts.masked ?? false;
    this.enclosingNonStepdefFrame().bindings.set(name, { kind: 'literal', value, masked });
    this._recordCapture(name, value, masked);
  }

  /**
   * Set a read-only literal binding in the current frame.
   * Once set, subsequent set() or setTransparent() calls for the same name are
   * silently ignored — matching pgwen.input.data.readOnly=true behaviour.
   */
  setReadonly(name: string, value: string, opts: SetOptions = {}): void {
    this.readonlyKeys.add(name);
    const masked = opts.masked ?? false;
    this.currentFrame.bindings.set(name, { kind: 'literal', value, masked });
    this._recordCapture(name, value, masked);
  }

  /**
   * Set a read-only literal binding in the nearest non-stepdef frame (transparent write).
   */
  setReadonlyTransparent(name: string, value: string, opts: SetOptions = {}): void {
    this.readonlyKeys.add(name);
    const masked = opts.masked ?? false;
    this.enclosingNonStepdefFrame().bindings.set(name, { kind: 'literal', value, masked });
    this._recordCapture(name, value, masked);
  }

  /**
   * Remove a key from the read-only set (e.g. when resetting between scenarios).
   */
  clearReadonly(name: string): void {
    this.readonlyKeys.delete(name);
  }

  /**
   * Clear all read-only key declarations. Called by Runner between scenarios
   * so feed bindings from one row don't permanently block the next row.
   */
  clearAllReadonly(): void {
    this.readonlyKeys.clear();
  }

  /**
   * Set a lazy binding whose value is computed fresh on every access.
   * Use for element text, page values, or anything dynamic.
   */
  setLazy(name: string, resolver: LazyResolver, opts: SetOptions = {}): void {
    const masked = opts.masked ?? false;
    this.currentFrame.bindings.set(name, { kind: 'lazy', resolver, masked });
    this._recordCapture(name, masked ? '*****' : '<lazy>', masked);
  }

  /**
   * Set a lazy binding in the nearest non-stepdef frame (transparent write).
   * Same standard behaviour rationale as setTransparent() — JS / file / regex bindings
   * created inside a StepDef body should outlive the stepdef scope.
   */
  setLazyTransparent(name: string, resolver: LazyResolver, opts: SetOptions = {}): void {
    const masked = opts.masked ?? false;
    this.enclosingNonStepdefFrame().bindings.set(name, { kind: 'lazy', resolver, masked });
    this._recordCapture(name, masked ? '*****' : '<lazy>', masked);
  }

  /**
   * Store a named locator function. Retrieved via getLocator(), not get().
   */
  setLocator(name: string, fn: LocatorFn): void {
    this.currentFrame.bindings.set(name, { kind: 'locator', fn });
  }

  /**
   * Store a locator binding in the nearest non-stepdef frame (transparent write).
   * Locators bound inside a StepDef body — e.g. `<element> can be located by css "..."` —
   * should remain accessible to subsequent steps after the stepdef scope pops.
   */
  setLocatorTransparent(name: string, fn: LocatorFn): void {
    this.enclosingNonStepdefFrame().bindings.set(name, { kind: 'locator', fn });
  }

  /**
   * Write into a specific layer by name rather than the current frame.
   * Useful for setting global or feature-level values from deep inside a StepDef.
   */
  setIn(layer: ScopeLayerName, name: string, value: string, opts: SetOptions = {}): void {
    const frame = this.frameFor(layer);
    const masked = opts.masked ?? false;
    frame.bindings.set(name, { kind: 'literal', value, masked });
    this._recordCapture(name, value, masked);
  }

  // ─── Reading bindings ────────────────────────────────────────────────────

  /**
   * Synchronously resolve a named binding from the innermost matching frame.
   * Lazy resolvers are NOT awaited here; call resolveAsync() for async support.
   * Returns undefined if no binding exists.
   */
  get(name: string): string | undefined {
    // env.VAR_NAME — mirrors ${env.VAR} interpolation; allows condition evaluators
    // like `env.PGWEN_ENV is "prod"` to resolve directly from process.env.
    if (name.startsWith('env.')) {
      const entry = this.findEntry(name);
      if (entry !== undefined && entry.kind !== 'locator') {
        // explicit scope binding takes precedence over process.env
      } else {
        return process.env[name.slice(4)];
      }
    }
    const entry = this.findEntry(name);
    if (entry === undefined) return undefined;
    if (entry.kind === 'locator') return undefined; // locators are not strings
    if (entry.kind === 'literal') return entry.value;
    // lazy — call resolver synchronously (sync resolvers return string, not Promise)
    const result = entry.resolver();
    if (typeof result === 'string') return result;
    // Promise returned from a lazy resolver — caller must use resolveAsync()
    throw new Error(
      `Binding "${name}" has an async lazy resolver. Use resolveAsync() instead of get().`
    );
  }

  /**
   * Asynchronously resolve a named binding, awaiting lazy resolvers.
   * Returns undefined if no binding exists.
   */
  async resolveAsync(name: string): Promise<string | undefined> {
    // env.VAR_NAME — consistent with get() behaviour
    if (name.startsWith('env.')) {
      const entry = this.findEntry(name);
      if (entry === undefined || entry.kind === 'locator') {
        return process.env[name.slice(4)];
      }
    }
    const entry = this.findEntry(name);
    if (entry === undefined) return undefined;
    if (entry.kind === 'locator') return undefined;
    if (entry.kind === 'literal') return entry.value;
    return await entry.resolver();
  }

  /**
   * Retrieve a locator function by name. Returns undefined if not found or
   * if the binding is not a locator.
   */
  getLocator(name: string): LocatorFn | undefined {
    const entry = this.findEntry(name);
    if (entry?.kind === 'locator') return entry.fn;
    return undefined;
  }

  /**
   * Returns true if a non-locator binding with the given name exists in any frame.
   */
  has(name: string): boolean {
    const entry = this.findEntry(name);
    return entry !== undefined && entry.kind !== 'locator';
  }

  /**
   * Returns true if a locator binding with the given name exists in any frame.
   */
  hasLocator(name: string): boolean {
    const entry = this.findEntry(name);
    return entry?.kind === 'locator';
  }

  /**
   * Returns whether the named binding is masked (value should be redacted in output).
   */
  isMasked(name: string): boolean {
    const entry = this.findEntry(name);
    if (!entry || entry.kind === 'locator') return false;
    return entry.masked;
  }

  /**
   * Collect all visible (non-locator) binding names from all frames,
   * innermost frame wins for duplicates.
   */
  allNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i]!;
      for (const [name, entry] of frame.bindings) {
        if (entry.kind !== 'locator' && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return names;
  }

  /**
   * Return a snapshot of all non-locator, non-masked bindings as a plain object.
   * Useful for REPL `.scope` command and debugging.
   */
  dump(): Record<string, string> {
    const result: Record<string, string> = {};
    // Iterate innermost-first; earlier writes win (innermost-wins semantics)
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i]!;
      for (const [name, entry] of frame.bindings) {
        if (entry.kind === 'locator' || entry.kind === 'lazy') continue;
        if (!(name in result)) {
          result[name] = entry.masked ? '***' : entry.value;
        }
      }
    }
    return result;
  }

  /**
   * Dump scope bindings grouped by layer — used by the REPL `env` command to
   * produce the reference framework-format output:
   *   env {
   *     scope : "feature" {
   *       x : "value"
   *       x/javascript : "source"
   *     }
   *   }
   *
   * Includes lazy bindings (shown as "<lazy>") unlike dump() which skips them.
   * Excludes locator entries and internal pgwen._ bookkeeping keys.
   * Entries are ordered as they appear in each frame (insertion order).
   */
  dumpByLayer(): Array<{ layer: string; bindings: Array<{ name: string; value: string }> }> {
    const layers: Array<{ layer: string; bindings: Array<{ name: string; value: string }> }> = [];
    for (const frame of this.frames) {
      const bindings: Array<{ name: string; value: string }> = [];
      for (const [name, entry] of frame.bindings) {
        if (entry.kind === 'locator') continue;
        if (name.startsWith('pgwen._')) continue; // internal bookkeeping
        // Skip lazy entries — JS-based bindings show their source via name/javascript literal.
        // Evaluated (literal) values appear once @Eager or explicit access resolves them.
        if (entry.kind === 'lazy') continue;
        const value = entry.masked ? '*****' : entry.value;
        bindings.push({ name, value });
      }
      if (bindings.length > 0) {
        layers.push({ layer: frame.layer, bindings });
      }
    }
    return layers;
  }

  /**
   * Clear all bindings in every frame (useful for REPL `.clear` command).
   * The frame stack structure is preserved.
   */
  clearAll(): void {
    for (const frame of this.frames) {
      frame.bindings.clear();
    }
  }

  /**
   * Create a new Scope with a single `feature` layer containing a snapshot of
   * all current non-locator bindings (innermost wins for duplicates).
   *
   * Used by PlaywrightRunner to capture the final scope state before the feature
   * layer is popped, so the post-execution REPL can inherit all bound variables.
   * Lazy bindings are included as-is — their resolver closures remain live.
   */
  snapshot(): Scope {
    const snap = new Scope();
    snap.push('feature');
    // Collect all non-locator bindings innermost-first (innermost wins)
    // and write into the snapshot using the public API.
    const seen = new Set<string>();
    for (let i = this.frames.length - 1; i >= 0; i--) {
      for (const [name, entry] of this.frames[i]!.bindings) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (entry.kind === 'locator') continue; // page-bound, not transferable
        if (entry.kind === 'lazy') {
          snap.setLazy(name, entry.resolver, { masked: entry.masked });
        } else {
          snap.set(name, entry.value, { masked: entry.masked });
        }
      }
    }
    return snap;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private get currentFrame(): ScopeFrame {
    return this.frames[this.frames.length - 1]!;
  }

  /**
   * Find the nearest frame from the top of the stack that is NOT a stepdef frame.
   * Used by transparent write methods so that bindings set inside StepDef bodies
   * land in the enclosing scenario/feature/global scope and survive scope.pop().
   * Falls back to the global frame if all frames are stepdef (should not happen).
   */
  private enclosingNonStepdefFrame(): ScopeFrame {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i]!.layer !== 'stepdef') return this.frames[i]!;
    }
    return this.frames[0]!; // global — unreachable in normal usage
  }

  private frameFor(layer: ScopeLayerName): ScopeFrame {
    // Find the outermost frame for this layer (global is always outermost)
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i]!.layer === layer) return this.frames[i]!;
    }
    throw new Error(`No frame exists for layer "${layer}". Push it first.`);
  }

  private findEntry(name: string): BindingEntry | undefined {
    // Innermost frame wins
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const entry = this.frames[i]!.bindings.get(name);
      if (entry !== undefined) return entry;
    }
    return undefined;
  }
}
