/**
 * Prompt content: what a person sends in one turn, as ACP carries it (issue #4).
 *
 * `PromptBlock` is ACP's own prompt ContentBlock, field for field -- `text`, `image` (base64 `data` + `mimeType`) and
 * an embedded `resource` holding either `text` or a base64 `blob` -- so a client can hand session/prompt's blocks to a
 * driver unchanged. A plain string is still a prompt: it is one text block.
 */

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageBlock {
  readonly type: 'image';
  readonly mimeType: string;
  /** Base64, no data-URL prefix. */
  readonly data: string;
  readonly uri?: string;
}

export interface TextResource {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

export interface BlobResource {
  readonly uri: string;
  readonly mimeType?: string;
  /** Base64. */
  readonly blob: string;
}

export interface ResourceBlock {
  readonly type: 'resource';
  readonly resource: TextResource | BlobResource;
}

export type PromptBlock = TextBlock | ImageBlock | ResourceBlock;

/** One turn: a string (one text block) or ACP content blocks. */
export type PromptContent = string | readonly PromptBlock[];

/**
 * The kinds a driver declares it takes, in `DriverCapabilities.promptBlocks`. A resource is two kinds because a
 * provider that reads a text file may have no documented way to take a binary one.
 */
export type PromptBlockKind = 'text' | 'image' | 'resource-text' | 'resource-blob';

/**
 * A prompt a driver will not send, naming the block. The WHOLE prompt is refused: sending the sentence without the
 * picture beside it would answer a question the person did not ask.
 */
export class PromptRefused extends Error {
  constructor(
    /** Zero-based position of the refused block. */
    readonly index: number,
    /** What the block was, as far as it could be read (`image/bmp`, `resource_link`, ...). */
    readonly block: string,
    reason: string,
  ) {
    super(`prompt refused at block ${index + 1} (${block}): ${reason}`);
    this.name = 'PromptRefused';
  }
}

/**
 * The image types both providers document taking: Anthropic's vision guide lists JPEG, PNG, GIF and WebP
 * (https://platform.claude.com/docs/en/build-with-claude/vision). An image of any other type is refused by name rather
 * than sent: the Agent SDK's streaming-input page records that an image Claude cannot read is replaced by a text note
 * and the session simply continues, which is a silent drop by another name.
 */
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The kind of a block, or null when it is not one of ACP's prompt blocks this package knows how to send. */
export function promptBlockKind(block: unknown): PromptBlockKind | null {
  const b = asRecord(block);
  if (b?.type === 'text') return 'text';
  if (b?.type === 'image') return 'image';
  if (b?.type === 'resource') {
    const r = asRecord(b.resource);
    if (r !== undefined && typeof r.text === 'string') return 'resource-text';
    if (r !== undefined && typeof r.blob === 'string') return 'resource-blob';
  }
  return null;
}

/** What a block is, for a refusal message: its MIME type where it has one, else its ACP type. */
function describe(block: unknown): string {
  const b = asRecord(block);
  if (b === undefined) return typeof block;
  const r = asRecord(b.resource);
  const mime = typeof b.mimeType === 'string' ? b.mimeType : typeof r?.mimeType === 'string' ? r.mimeType : undefined;
  const type = typeof b.type === 'string' ? b.type : 'untyped';
  return mime === undefined ? type : `${type} ${mime}`;
}

/** A label a person would recognise for each kind, in a refusal. */
const KIND_LABEL: Record<PromptBlockKind, string> = {
  text: 'text',
  image: 'images',
  'resource-text': 'text files',
  'resource-blob': 'binary files',
};

/**
 * Check a prompt against what a driver takes and return its blocks. Throws {@link PromptRefused} for the FIRST block
 * it will not send -- an unknown type, a kind outside `accepts`, an image of an undocumented type, or a block whose
 * required fields are missing or empty -- so nothing is written for a prompt that would arrive incomplete.
 */
export function promptBlocks(content: PromptContent, accepts: readonly PromptBlockKind[]): readonly PromptBlock[] {
  const blocks: readonly unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (blocks.length === 0) throw new Error('a prompt needs at least one block');
  blocks.forEach((block, index) => {
    const kind = promptBlockKind(block);
    if (kind === null) throw new PromptRefused(index, describe(block), 'not a prompt block this driver can send');
    if (!accepts.includes(kind)) {
      throw new PromptRefused(index, describe(block), `this driver does not take ${KIND_LABEL[kind]}`);
    }
    const b = block as Record<string, unknown>;
    if (kind === 'text' && typeof b.text !== 'string') throw new PromptRefused(index, 'text', 'it has no text');
    if (kind === 'image') {
      if (typeof b.mimeType !== 'string' || !(PROMPT_IMAGE_TYPES as readonly string[]).includes(b.mimeType)) {
        throw new PromptRefused(index, describe(block), `images must be one of ${PROMPT_IMAGE_TYPES.join(', ')}`);
      }
      if (typeof b.data !== 'string' || b.data.length === 0 || !BASE64.test(b.data)) {
        throw new PromptRefused(index, describe(block), 'its data is not base64 image bytes');
      }
    }
    if (kind === 'resource-text' || kind === 'resource-blob') {
      const r = b.resource as Record<string, unknown>;
      if (typeof r.uri !== 'string' || r.uri.length === 0) throw new PromptRefused(index, describe(block), 'it has no uri');
      if (kind === 'resource-blob' && (r.blob as string).length === 0) {
        throw new PromptRefused(index, describe(block), 'its blob is empty');
      }
    }
  });
  return blocks as readonly PromptBlock[];
}

/**
 * A text file as prompt text: its uri and type on an opening line, then its text, then a closing line, so the model
 * can tell where the file starts and ends and which file it is.
 */
export function fileAsText(resource: TextResource): string {
  const mime = resource.mimeType === undefined ? '' : ` (${resource.mimeType})`;
  return `<file ${resource.uri}${mime}>\n${resource.text}\n</file>`;
}
