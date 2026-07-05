/**
 * TagFilter.ts — Filter scenarios by tag expressions.
 *
 * Tag expression syntax (matches the reference framework CLI --tags argument):
 *   @tag              — include only scenarios tagged @tag
 *   ~@tag             — exclude scenarios tagged @tag (tilde = NOT)
 *   @tag1 and @tag2   — both tags required
 *   @tag1 or @tag2    — either tag
 *   @tag1 and ~@tag2  — has tag1, does NOT have tag2
 *
 * Usage:
 *   const filter = TagFilter.fromExpression('@smoke and ~@wip');
 *   const passes = filter.matches(scenario.tags);
 */

// ─── Internal AST nodes ───────────────────────────────────────────────────────

type TagNode =
  | { type: 'tag'; tag: string; negate: boolean }
  | { type: 'and'; left: TagNode; right: TagNode }
  | { type: 'or'; left: TagNode; right: TagNode }
  | { type: 'all' };

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Tokenise a tag expression into a list of tokens.
 * Tokens are: tag strings (possibly prefixed with ~), 'and', 'or', '(', ')'.
 * Parentheses are separated from adjacent tokens so `(@smoke or @wip)` works.
 */
function tokenise(expr: string): string[] {
  return expr
    .trim()
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Parse a single tag term: `@tag` or `~@tag`.
 * Tag may have parenthetical args like @Timeout('10s') — we strip those.
 */
function parseTerm(token: string): TagNode {
  const negate = token.startsWith('~');
  const raw = negate ? token.slice(1) : token;
  // Strip leading @, then strip any parenthetical args: @Tag('val') → tag
  const tagBody = raw.startsWith('@') ? raw.slice(1) : raw;
  // Normalise: strip parenthetical content for matching (e.g. @Timeout('10s') → Timeout)
  const tag = tagBody.replace(/\(.*\)$/, '').toLowerCase();
  return { type: 'tag', tag, negate };
}

/**
 * Parse the expression using recursive descent.
 * Grammar (simplified, no explicit precedence tokens):
 *   expr   := andExpr (OR andExpr)*
 *   andExpr := term (AND term)*
 *   term    := TAG_TOKEN
 */
function parseExpr(tokens: string[], pos: { i: number }): TagNode {
  let node = parseAndExpr(tokens, pos);

  while (pos.i < tokens.length) {
    const tok = tokens[pos.i];
    if (tok === undefined || tok.toLowerCase() !== 'or') break;
    pos.i++;
    const right = parseAndExpr(tokens, pos);
    node = { type: 'or', left: node, right };
  }

  return node;
}

function parseAndExpr(tokens: string[], pos: { i: number }): TagNode {
  let node = parseSingleTerm(tokens, pos);

  while (pos.i < tokens.length) {
    const tok = tokens[pos.i];
    if (tok === undefined || tok.toLowerCase() !== 'and') break;
    pos.i++;
    const right = parseSingleTerm(tokens, pos);
    node = { type: 'and', left: node, right };
  }

  return node;
}

function parseSingleTerm(tokens: string[], pos: { i: number }): TagNode {
  const tok = tokens[pos.i];
  if (tok === undefined) {
    throw new Error(`Tag expression parse error: unexpected end of expression`);
  }

  // Parenthesised sub-expression: ( expr )
  if (tok === '(') {
    pos.i++; // consume '('
    const node = parseExpr(tokens, pos);
    const closing = tokens[pos.i];
    if (closing !== ')') {
      throw new Error(
        `Tag expression parse error: expected ')' but got '${closing ?? 'end of expression'}'`
      );
    }
    pos.i++; // consume ')'
    return node;
  }

  pos.i++;
  return parseTerm(tok);
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

function evaluate(node: TagNode, tagSet: Set<string>): boolean {
  switch (node.type) {
    case 'all':
      return true;
    case 'tag': {
      const present = tagSet.has(node.tag);
      return node.negate ? !present : present;
    }
    case 'and':
      return evaluate(node.left, tagSet) && evaluate(node.right, tagSet);
    case 'or':
      return evaluate(node.left, tagSet) || evaluate(node.right, tagSet);
  }
}

/**
 * Normalise a scenario tags array to a lowercase Set of tag names (without @).
 */
function normaliseTags(tags: readonly string[]): Set<string> {
  return new Set(
    tags.map((t) => {
      const raw = t.startsWith('@') ? t.slice(1) : t;
      // Strip parenthetical args
      return raw.replace(/\(.*\)$/, '').toLowerCase();
    })
  );
}

// ─── TagFilter class ──────────────────────────────────────────────────────────

export class TagFilter {
  private readonly node: TagNode;

  private constructor(node: TagNode) {
    this.node = node;
  }

  /**
   * Parse a tag expression string into a TagFilter.
   * Empty/whitespace expression → matches all (same as none()).
   */
  static fromExpression(expr: string | undefined): TagFilter {
    if (!expr || expr.trim().length === 0) {
      return TagFilter.none();
    }
    const tokens = tokenise(expr);
    const pos = { i: 0 };
    const node = parseExpr(tokens, pos);
    return new TagFilter(node);
  }

  /**
   * Returns a filter that passes all scenarios (no filtering).
   */
  static none(): TagFilter {
    return new TagFilter({ type: 'all' });
  }

  /**
   * Returns true if the scenario's tags pass this filter expression.
   */
  matches(tags: readonly string[]): boolean {
    const tagSet = normaliseTags(tags);
    return evaluate(this.node, tagSet);
  }
}

// ─── Convenience function ─────────────────────────────────────────────────────

/**
 * Convenience function: returns true if the scenario tags match the expression.
 * If expression is undefined or empty, always returns true.
 */
export function matchesTags(
  scenarioTags: readonly string[],
  expression: string | undefined
): boolean {
  return TagFilter.fromExpression(expression).matches(scenarioTags);
}
