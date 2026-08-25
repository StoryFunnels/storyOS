import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TokenScope } from '@storyos/schemas';

/**
 * Tyron's tool catalog (#357, ADR-0016 §1).
 *
 * Tyron is an MCP **client** of our own MCP server. It holds no tool definitions
 * of its own and discovers the catalog at runtime, so it cannot drift from
 * `packages/mcp/src/tools.ts` — a tool added, renamed or re-gated there is
 * immediately and identically true here, with nothing to keep in step.
 *
 * That is the whole point. #357's rule is "one tool layer, not two", and the scar
 * it cites is #343: four MCP tools that disagreed about the shape of a record
 * because the write paths bypassed the read serialiser. Sharing the running
 * service rather than sharing code is the only version of that rule which cannot
 * rot, because there is no second copy to forget.
 *
 * It also means every call traverses the real guard stack — AuthGuard,
 * WorkspaceAccessGuard, scope enforcement, the same validators — because it
 * arrives as an ordinary authenticated API call. ADR-0010 §2's promise that "the
 * same guard stack that gates a PAT gates an agent run" becomes literally true.
 *
 * Uses the MCP SDK rather than plain `fetch`, departing from
 * `managed-ai-client.ts`'s no-SDK precedent on purpose: OpenAI's REST call is a
 * single POST, whereas MCP's Streamable HTTP carries an initialize handshake,
 * session ids and SSE framing. Hand-rolling that is where a client goes subtly
 * and silently wrong.
 */

/** One tool as the MCP server advertises it. Shapes come from the server, never from us. */
export interface TyronTool {
  name: string;
  description: string;
  /** JSON Schema, passed to the model verbatim — we do not re-describe arguments. */
  inputSchema: unknown;
}

export interface TyronToolResult {
  /** The tool's text output, concatenated. */
  text: string;
  /**
   * True when the tool itself reported a failure (MCP `isError`), as opposed to
   * the transport failing. The distinction matters: a permission denial is a
   * normal, explainable outcome (#357 — "a permission-denied action produces a
   * plain explanation, not a crash"), while a transport error means Tyron has no
   * tools at all and must say so.
   */
  isError: boolean;
}

export interface TyronToolCatalog {
  list(): Promise<TyronTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<TyronToolResult>;
  close(): Promise<void>;
}

/**
 * Thrown when the MCP service cannot be reached at all.
 *
 * Deliberately its own type. ADR-0016 §1 accepts an availability edge (api → mcp)
 * and requires that when it breaks, Tyron says it cannot reach its tools rather
 * than degrading into a chat box that answers confidently and acts on nothing.
 * A generic error would be swallowed by the turn loop's ordinary failure path and
 * reported as if a tool had simply declined.
 */
export class ToolsUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      "I can't reach my tools right now, so I haven't done anything to your workspace. " +
        'This is a problem on our side, not with what you asked. Please try again in a moment.',
    );
    this.name = 'ToolsUnreachableError';
    this.cause = cause;
  }
}

export class McpToolCatalog implements TyronToolCatalog {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  /**
   * @param url    The MCP endpoint (`TYRON_MCP_URL`).
   * @param token  A short-lived token scoped to the asking MEMBER (ADR-0016 §2).
   *               Never a shared service credential — a single token Tyron used
   *               for everybody would be a permission surface of its own, which
   *               is exactly what attributing everything to the person prevents.
   */
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'storyos-tyron', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      // The member's token, forwarded exactly as any other MCP client would send
      // it. The server does not know or care that the caller is Tyron — which is
      // the property that keeps the guard stack honest.
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
    });
    try {
      await client.connect(transport);
    } catch (err) {
      throw new ToolsUnreachableError(err);
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  async list(): Promise<TyronTool[]> {
    const client = await this.connect();
    let result;
    try {
      result = await client.listTools();
    } catch (err) {
      throw new ToolsUnreachableError(err);
    }
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<TyronToolResult> {
    const client = await this.connect();
    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      // A tool that does not exist, or arguments the server rejects, come back
      // as a thrown protocol error rather than an isError result. That is a
      // normal outcome for a model that guessed — report it as a tool failure so
      // the loop can hand the text back and let the model correct itself, rather
      // than aborting the whole turn.
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    // Best-effort: a failure to close a transport must never fail the turn the
    // user was waiting on.
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.client = undefined;
    this.transport = undefined;
  }
}

/**
 * The scope Tyron's token is minted with.
 *
 * #357a is READ-ONLY, and this is how that is enforced: the MCP server already
 * gates tool *registration* on the token's scope, so a `read` token is never even
 * advertised a write tool. The restriction therefore lives on the server, in the
 * same place it lives for every other client — not in a client-side allowlist
 * here that could fall out of date, and not in a prompt instruction the model is
 * free to ignore.
 *
 * #357b changes this one value to the member's own effective scope. That is the
 * entire diff for enabling writes, which is the point: a phase boundary that is
 * one line is a phase boundary that can be trusted.
 */
export const TYRON_READ_ONLY_SCOPE: TokenScope = 'read';
