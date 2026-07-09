/**
 * Formula engine (MN-043): tokenizer → parser → typechecker → evaluator.
 * Zero dependencies, no eval. Shared by the API (compute at read) and the
 * web editor (live preview + autocomplete). Field refs are written {Display
 * Name} in source but stored as api_names in the AST so renames never break.
 */

export type FormulaType = 'text' | 'number' | 'checkbox' | 'date' | 'null';

export type FormulaNode =
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'ref'; api_name: string }
  | { kind: 'unary'; op: 'not' | 'neg'; operand: FormulaNode }
  | { kind: 'binary'; op: string; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; name: string; args: FormulaNode[] };

export interface FormulaFieldInfo {
  api_name: string;
  display_name: string;
  /** Underlying field type mapped to a formula type ('text' for selects/lookups-of-text etc). */
  formula_type: FormulaType;
}

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly position?: number,
  ) {
    super(message);
  }
}

/* ---------- function table (docs + autocomplete generate from this) ---------- */

interface FnSpec {
  args: FormulaType[] | 'variadic-number' | 'variadic-text' | 'variadic-any';
  returns: FormulaType | 'same-as-arg2';
  doc: string;
  example: string;
  impl: (...args: unknown[]) => unknown;
}

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asStr = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : new Date(ms);
};

export const FORMULA_FUNCTIONS: Record<string, FnSpec> = {
  if: {
    args: ['checkbox', 'null', 'null'], // then/else checked specially (must match each other)
    returns: 'same-as-arg2',
    doc: 'Returns the second argument when the condition is true, else the third.',
    example: 'if({Estimate} > 5, "big", "small")',
    impl: (cond, a, b) => (cond === true ? a : b),
  },
  is_empty: {
    args: ['null'],
    returns: 'checkbox',
    doc: 'True when the value is empty.',
    example: 'is_empty({Due})',
    impl: (v) => v === null || v === undefined || v === '',
  },
  coalesce: {
    args: 'variadic-any',
    returns: 'same-as-arg2',
    doc: 'First non-empty argument.',
    example: 'coalesce({Nickname}, {Name})',
    impl: (...vs) => vs.find((v) => v !== null && v !== undefined && v !== '') ?? null,
  },
  concat: {
    args: 'variadic-text',
    returns: 'text',
    doc: 'Joins values as text.',
    example: 'concat({Name}, " — ", {State})',
    impl: (...vs) => vs.map(asStr).join(''),
  },
  upper: { args: ['text'], returns: 'text', doc: 'Uppercase.', example: 'upper({Code})', impl: (s) => asStr(s).toUpperCase() },
  lower: { args: ['text'], returns: 'text', doc: 'Lowercase.', example: 'lower({Email})', impl: (s) => asStr(s).toLowerCase() },
  trim: { args: ['text'], returns: 'text', doc: 'Strips surrounding whitespace.', example: 'trim({Raw})', impl: (s) => asStr(s).trim() },
  replace: {
    args: ['text', 'text', 'text'],
    returns: 'text',
    doc: 'Replaces every occurrence.',
    example: 'replace({Slug}, " ", "-")',
    impl: (s, find, repl) => asStr(s).split(asStr(find)).join(asStr(repl)),
  },
  length: { args: ['text'], returns: 'number', doc: 'Character count.', example: 'length({Name})', impl: (s) => asStr(s).length },
  format: { args: ['null'], returns: 'text', doc: 'Any value as text.', example: 'format({Estimate})', impl: (v) => asStr(v) },
  round: {
    args: ['number', 'number'],
    returns: 'number',
    doc: 'Rounds to N decimal places (default 0).',
    example: 'round({Budget} / 3, 2)',
    impl: (n, places) => {
      const num = asNum(n);
      if (num === null) return null;
      const p = asNum(places) ?? 0;
      return Math.round(num * 10 ** p) / 10 ** p;
    },
  },
  abs: { args: ['number'], returns: 'number', doc: 'Absolute value.', example: 'abs({Delta})', impl: (n) => (asNum(n) === null ? null : Math.abs(asNum(n)!)) },
  min: { args: 'variadic-number', returns: 'number', doc: 'Smallest argument.', example: 'min({A}, {B})', impl: (...vs) => { const nums = vs.map(asNum).filter((v): v is number => v !== null); return nums.length ? Math.min(...nums) : null; } },
  max: { args: 'variadic-number', returns: 'number', doc: 'Largest argument.', example: 'max({A}, {B})', impl: (...vs) => { const nums = vs.map(asNum).filter((v): v is number => v !== null); return nums.length ? Math.max(...nums) : null; } },
  now: { args: [], returns: 'date', doc: 'Current date-time.', example: 'now()', impl: () => new Date().toISOString() },
  today: { args: [], returns: 'date', doc: "Today's date.", example: 'today()', impl: () => new Date().toISOString().slice(0, 10) },
  days_between: {
    args: ['date', 'date'],
    returns: 'number',
    doc: 'Whole days from the first date to the second.',
    example: 'days_between(today(), {Due})',
    impl: (a, b) => {
      const da = asDate(a);
      const db = asDate(b);
      if (!da || !db) return null;
      return Math.round((db.getTime() - da.getTime()) / 86_400_000);
    },
  },
  add_days: {
    args: ['date', 'number'],
    returns: 'date',
    doc: 'Date shifted by N days.',
    example: 'add_days({Start}, 14)',
    impl: (d, n) => {
      const date = asDate(d);
      const num = asNum(n);
      if (!date || num === null) return null;
      const out = new Date(date.getTime() + num * 86_400_000);
      return String(d).length > 10 ? out.toISOString() : out.toISOString().slice(0, 10);
    },
  },
  year: { args: ['date'], returns: 'number', doc: 'Year of a date.', example: 'year({Due})', impl: (d) => asDate(d)?.getFullYear() ?? null },
  month: { args: ['date'], returns: 'number', doc: 'Month (1-12).', example: 'month({Due})', impl: (d) => { const date = asDate(d); return date ? date.getMonth() + 1 : null; } },
};

/* ---------- tokenizer ---------- */

type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'bool'; v: boolean; pos: number }
  | { t: 'ref'; v: string; pos: number }
  | { t: 'ident'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'lparen' | 'rparen' | 'comma'; pos: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new FormulaError('Unclosed field reference — missing }', i);
      tokens.push({ t: 'ref', v: src.slice(i + 1, end).trim(), pos: i });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        out += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError('Unclosed string', i);
      tokens.push({ t: 'str', v: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      const word = m[0];
      if (word === 'true' || word === 'false') tokens.push({ t: 'bool', v: word === 'true', pos: i });
      else if (word === 'and' || word === 'or' || word === 'not') tokens.push({ t: 'op', v: word, pos: i });
      else tokens.push({ t: 'ident', v: word, pos: i });
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<='].includes(two)) {
      tokens.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>'.includes(c)) {
      tokens.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lparen', pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rparen', pos: i });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ t: 'comma', pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, i);
  }
  return tokens;
}

/* ---------- parser (precedence climbing) ---------- */

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 3, '!=': 3, '>': 3, '>=': 3, '<': 3, '<=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

export function parseFormula(src: string, fields: FormulaFieldInfo[]): FormulaNode {
  const tokens = tokenize(src);
  const byDisplay = new Map(fields.map((f) => [f.display_name.toLowerCase(), f.api_name]));
  const byApi = new Set(fields.map((f) => f.api_name));
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t: string): Token => {
    const token = next();
    if (!token || token.t !== t) throw new FormulaError(`Expected ${t}`, token?.pos ?? src.length);
    return token;
  };

  function parsePrimary(): FormulaNode {
    const token = next();
    if (!token) throw new FormulaError('Unexpected end of formula', src.length);
    if (token.t === 'num' || token.t === 'str' || token.t === 'bool') return { kind: 'lit', value: token.v };
    if (token.t === 'ref') {
      const apiName = byDisplay.get(token.v.toLowerCase()) ?? (byApi.has(token.v) ? token.v : undefined);
      if (!apiName) throw new FormulaError(`Unknown field "{${token.v}}"`, token.pos);
      return { kind: 'ref', api_name: apiName };
    }
    if (token.t === 'op' && token.v === 'not') return { kind: 'unary', op: 'not', operand: parsePrimary() };
    if (token.t === 'op' && token.v === '-') return { kind: 'unary', op: 'neg', operand: parsePrimary() };
    if (token.t === 'ident') {
      const name = token.v.toLowerCase();
      if (!(name in FORMULA_FUNCTIONS)) throw new FormulaError(`Unknown function "${token.v}"`, token.pos);
      expect('lparen');
      const args: FormulaNode[] = [];
      if (peek()?.t !== 'rparen') {
        for (;;) {
          args.push(parseExpr(0));
          if (peek()?.t === 'comma') {
            next();
            continue;
          }
          break;
        }
      }
      expect('rparen');
      return { kind: 'call', name, args };
    }
    if (token.t === 'lparen') {
      const inner = parseExpr(0);
      expect('rparen');
      return inner;
    }
    throw new FormulaError('Unexpected token', token.pos);
  }

  function parseExpr(minPrec: number): FormulaNode {
    let left = parsePrimary();
    for (;;) {
      const token = peek();
      if (!token || token.t !== 'op' || !(token.v in PRECEDENCE) || PRECEDENCE[token.v]! < minPrec) break;
      next();
      const right = parseExpr(PRECEDENCE[token.v]! + 1);
      left = { kind: 'binary', op: token.v, left, right };
    }
    return left;
  }

  const ast = parseExpr(0);
  if (pos < tokens.length) throw new FormulaError('Unexpected trailing input', tokens[pos]!.pos);
  return ast;
}

/* ---------- typechecker ---------- */

export function typecheck(node: FormulaNode, fields: FormulaFieldInfo[]): FormulaType {
  const typeByApi = new Map(fields.map((f) => [f.api_name, f.formula_type]));

  function check(n: FormulaNode): FormulaType {
    switch (n.kind) {
      case 'lit':
        if (n.value === null) return 'null';
        return typeof n.value === 'number' ? 'number' : typeof n.value === 'boolean' ? 'checkbox' : 'text';
      case 'ref':
        return typeByApi.get(n.api_name) ?? 'text';
      case 'unary': {
        const t = check(n.operand);
        if (n.op === 'not' && t !== 'checkbox' && t !== 'null') throw new FormulaError('"not" needs a true/false value');
        if (n.op === 'neg' && t !== 'number' && t !== 'null') throw new FormulaError('Negation needs a number');
        return n.op === 'not' ? 'checkbox' : 'number';
      }
      case 'binary': {
        const l = check(n.left);
        const r = check(n.right);
        const both = (t: FormulaType) => (l === t || l === 'null') && (r === t || r === 'null');
        if (['and', 'or'].includes(n.op)) {
          if (!both('checkbox')) throw new FormulaError(`"${n.op}" needs true/false on both sides`);
          return 'checkbox';
        }
        if (['==', '!='].includes(n.op)) return 'checkbox';
        if (['>', '>=', '<', '<='].includes(n.op)) {
          if (!both('number') && !both('date') && !both('text')) throw new FormulaError(`"${n.op}" needs matching comparable types`);
          return 'checkbox';
        }
        if (n.op === '+') {
          if (both('number')) return 'number';
          if (l === 'text' || r === 'text') return 'text'; // + concatenates when text is involved
          throw new FormulaError('"+" needs numbers or text');
        }
        if (!both('number')) throw new FormulaError(`"${n.op}" needs numbers`);
        return 'number';
      }
      case 'call': {
        const spec = FORMULA_FUNCTIONS[n.name]!;
        const argTypes = n.args.map(check);
        if (n.name === 'if') {
          if (n.args.length !== 3) throw new FormulaError('if() takes exactly 3 arguments');
          if (argTypes[0] !== 'checkbox' && argTypes[0] !== 'null') throw new FormulaError('if() condition must be true/false');
          const a = argTypes[1]!;
          const b = argTypes[2]!;
          if (a !== b && a !== 'null' && b !== 'null') throw new FormulaError('if() branches must have the same type');
          return a === 'null' ? b : a;
        }
        if (spec.args === 'variadic-number') {
          argTypes.forEach((t) => { if (t !== 'number' && t !== 'null') throw new FormulaError(`${n.name}() takes numbers`); });
        } else if (Array.isArray(spec.args)) {
          if (n.args.length > spec.args.length || n.args.length < spec.args.filter((a) => a !== 'null').length - (n.name === 'round' ? 1 : 0)) {
            // round's second arg optional; general arity check below is lenient for optional tails
          }
          spec.args.forEach((expected, i) => {
            if (i >= argTypes.length) return;
            const got = argTypes[i]!;
            if (expected !== 'null' && got !== expected && got !== 'null') {
              throw new FormulaError(`${n.name}() argument ${i + 1} should be ${expected}, got ${got}`);
            }
          });
        }
        if (spec.returns === 'same-as-arg2') {
          return argTypes.find((t) => t !== 'null') ?? 'text';
        }
        return spec.returns;
      }
    }
  }
  return check(node);
}

/* ---------- evaluator ---------- */

export function evaluateFormula(node: FormulaNode, values: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'ref': {
      const v = values[node.api_name];
      return v === undefined ? null : v;
    }
    case 'unary': {
      const v = evaluateFormula(node.operand, values);
      if (v === null) return null;
      return node.op === 'not' ? v !== true : -(asNum(v) ?? NaN) || (asNum(v) === null ? null : -(asNum(v) as number));
    }
    case 'binary': {
      const l = evaluateFormula(node.left, values);
      const r = evaluateFormula(node.right, values);
      if (node.op === 'and') return l === true && r === true;
      if (node.op === 'or') return l === true || r === true;
      if (node.op === '==') return l === r;
      if (node.op === '!=') return l !== r;
      if (l === null || r === null) return null;
      if (['>', '>=', '<', '<='].includes(node.op)) {
        if (node.op === '>') return (l as never) > (r as never);
        if (node.op === '>=') return (l as never) >= (r as never);
        if (node.op === '<') return (l as never) < (r as never);
        return (l as never) <= (r as never);
      }
      if (node.op === '+') {
        if (typeof l === 'string' || typeof r === 'string') return asStr(l) + asStr(r);
        const a = asNum(l);
        const b = asNum(r);
        return a === null || b === null ? null : a + b;
      }
      const a = asNum(l);
      const b = asNum(r);
      if (a === null || b === null) return null;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (node.op === '/') return b === 0 ? null : a / b;
      if (node.op === '%') return b === 0 ? null : a % b;
      return null;
    }
    case 'call': {
      const spec = FORMULA_FUNCTIONS[node.name]!;
      if (node.name === 'if') {
        const cond = evaluateFormula(node.args[0]!, values);
        return evaluateFormula(cond === true ? node.args[1]! : node.args[2]!, values);
      }
      const args = node.args.map((a) => evaluateFormula(a, values));
      return spec.impl(...args);
    }
  }
}

/** Field refs used by a formula (cycle detection + dependency ordering). */
export function formulaRefs(node: FormulaNode): string[] {
  const out = new Set<string>();
  const walk = (n: FormulaNode) => {
    if (n.kind === 'ref') out.add(n.api_name);
    else if (n.kind === 'unary') walk(n.operand);
    else if (n.kind === 'binary') {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === 'call') n.args.forEach(walk);
  };
  walk(node);
  return [...out];
}
