// =============================================================================
// Template Parsing
// =============================================================================

type Node = LiteralNode | ChoiceNode;

interface LiteralNode {
  type: "literal";
  value: string;
}

interface ChoiceNode {
  type: "choice";
  alternatives: Node[][];
}

/**
 * Parse a template string into an AST.
 * Syntax: {a|b|c} for choices, with nesting support.
 * Escaping: \{ \} \| \\
 */
export function parseTemplate(template: string): Node[] {
  let pos = 0;

  function parseSequence(stopChars: string[]): Node[] {
    const nodes: Node[] = [];
    let literal = "";

    while (pos < template.length) {
      const ch = template[pos];

      // Handle escapes
      if (ch === "\\" && pos + 1 < template.length) {
        const next = template[pos + 1];
        if ("{|}\\".includes(next)) {
          literal += next;
          pos += 2;
          continue;
        }
      }

      // Stop at delimiter
      if (stopChars.includes(ch)) {
        if (literal) {
          nodes.push({ type: "literal", value: literal });
        }
        return nodes;
      }

      // Start of choice
      if (ch === "{") {
        if (literal) {
          nodes.push({ type: "literal", value: literal });
          literal = "";
        }
        pos++; // consume '{'
        nodes.push(parseChoice());
      } else {
        literal += ch;
        pos++;
      }
    }

    if (literal) {
      nodes.push({ type: "literal", value: literal });
    }
    return nodes;
  }

  function parseChoice(): ChoiceNode {
    const alternatives: Node[][] = [];

    while (true) {
      alternatives.push(parseSequence(["|", "}"]));

      if (pos >= template.length) {
        throw new Error("Unclosed brace in template");
      }

      const ch = template[pos];
      pos++; // consume '|' or '}'

      if (ch === "}") {
        break;
      }
    }

    return { type: "choice", alternatives };
  }

  return parseSequence([]);
}

/**
 * Count total variations in a parsed template.
 */
export function countVariations(nodes: Node[]): number {
  let count = 1;

  for (const node of nodes) {
    if (node.type === "choice") {
      const altCounts = node.alternatives.map((alt) => countVariations(alt));
      const sum = altCounts.reduce((a, b) => a + b, 0);
      count *= sum;
    }
  }

  return count;
}

/**
 * Count variations in a template string.
 */
export function templateVariations(template: string): number {
  const nodes = parseTemplate(template);
  return countVariations(nodes);
}

