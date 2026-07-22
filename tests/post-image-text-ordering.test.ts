import { describe, it, expect } from 'vitest';
import { createEventDispatcher } from '../src/feishu/event-handler.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * PR #320 invariant, tested end-to-end through the public dispatcher entry
 * (no internals exported):
 *
 *   event-handler injects [Image N] placeholders into post text in visual
 *   order; the first image travels as `imageKey`, the rest as `extraMedia`
 *   in that same order. message-bridge numbers downloads identically
 *   (main imageKey = [Image 1], extra images increment the counter, files
 *   never take a number), so if this ordering breaks, the agent silently
 *   maps the wrong file path to the wrong in-text anchor.
 *
 * Covers the three review asks: direct + locale-wrapped post shapes,
 * interleaved text/images, and post images combined with cached group media.
 */

const BOT_OPEN_ID = 'ou_bot_self';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

function makeDispatcher(
  onMessage: (m: IncomingMessage) => void,
  opts: { botOpenId?: string } = {},
) {
  const config = { groupNoMention: false } as any;
  return createEventDispatcher(config, silentLogger, onMessage, opts.botOpenId);
}

interface InvokeOpts {
  msgId: string;
  chatId: string;
  userId: string;
  msgType: 'text' | 'post' | 'image' | 'file';
  content: unknown;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ id: { open_id: string } }>;
}

/** Feed one im.message.receive_v1 event (schema 2.0) through the dispatcher. */
function invokeMessage(dispatcher: any, opts: InvokeOpts) {
  return dispatcher.invoke(
    {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: opts.userId } },
        message: {
          message_id: opts.msgId,
          chat_id: opts.chatId,
          chat_type: opts.chatType ?? 'p2p',
          message_type: opts.msgType,
          content: JSON.stringify(opts.content),
          ...(opts.mentions ? { mentions: opts.mentions } : {}),
        },
      },
    },
    { needCheck: false },
  );
}

/** One paragraph of post body: text -> image -> text -> image variants below. */
const TWO_IMAGE_BODY = {
  title: 'Title',
  content: [
    [{ tag: 'text', text: 'look: ' }, { tag: 'img', image_key: 'k_a' }],
  ],
};

describe('post shapes: direct and locale-wrapped', () => {
  it('direct shape (no locale wrapper) extracts title, text and [Image 1] anchor', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_direct', chatId: 'oc_direct', userId: 'ou_u',
      msgType: 'post', content: TWO_IMAGE_BODY,
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('Title\nlook: [Image 1]');
    expect(received[0].imageKey).toBe('k_a');
    expect(received[0].extraMedia).toBeUndefined();
  });

  it('locale-wrapped shape (zh_cn) extracts identically to the direct shape', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_locale', chatId: 'oc_locale', userId: 'ou_u',
      msgType: 'post', content: { zh_cn: TWO_IMAGE_BODY },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('Title\nlook: [Image 1]');
    expect(received[0].imageKey).toBe('k_a');
  });

  it('locale wrapper skips malformed locale values and uses the first with a content array', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_mixed', chatId: 'oc_mixed', userId: 'ou_u',
      msgType: 'post',
      content: { en_us: 'bogus', ja_jp: { title: 'no content array' }, zh_cn: TWO_IMAGE_BODY },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('Title\nlook: [Image 1]');
    expect(received[0].imageKey).toBe('k_a');
  });
});

describe('interleaved text/images', () => {
  it('text→image→text→image keeps placeholders in position and imageKeys in the same order', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_inter', chatId: 'oc_inter', userId: 'ou_u',
      msgType: 'post',
      content: {
        content: [
          [{ tag: 'text', text: '第一段说明。' }],
          [{ tag: 'img', image_key: 'k_first' }],
          [{ tag: 'text', text: '第二段说明。' }],
          [{ tag: 'img', image_key: 'k_second' }],
        ],
      },
    });

    expect(received).toHaveLength(1);
    const m = received[0];
    expect(m.text).toBe('第一段说明。\n[Image 1]\n第二段说明。\n[Image 2]');
    // First image rides as imageKey ([Image 1]); the rest follow as extraMedia
    // in placeholder order ([Image 2], ...).
    expect(m.imageKey).toBe('k_first');
    expect(m.extraMedia).toEqual([{ messageId: 'om_inter', imageKey: 'k_second' }]);
  });

  it('inline mix in one paragraph stays on one line, link (a) text included', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_inline', chatId: 'oc_inline', userId: 'ou_u',
      msgType: 'post',
      content: {
        content: [[
          { tag: 'text', text: 'A' },
          { tag: 'img', image_key: 'k1' },
          { tag: 'a', text: 'link' },
          { tag: 'img', image_key: 'k2' },
        ]],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('A[Image 1]link[Image 2]');
    expect(received[0].imageKey).toBe('k1');
    expect(received[0].extraMedia).toEqual([{ messageId: 'om_inline', imageKey: 'k2' }]);
  });

  it('image-only post yields placeholder-only text (not the bare-image default prompt)', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_imgonly', chatId: 'oc_imgonly', userId: 'ou_u',
      msgType: 'post',
      content: { content: [[{ tag: 'img', image_key: 'k_only' }]] },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('[Image 1]');
    expect(received[0].imageKey).toBe('k_only');
  });

  it('plain-text post passes through with no placeholders and no imageKey', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m));

    await invokeMessage(d, {
      msgId: 'om_plain', chatId: 'oc_plain', userId: 'ou_u',
      msgType: 'post',
      content: { content: [[{ tag: 'text', text: 'just words' }]] },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('just words');
    expect(received[0].imageKey).toBeUndefined();
    expect(received[0].extraMedia).toBeUndefined();
  });
});

describe('post images combined with cached group media', () => {
  it('cached media appends after post extras; anchors stay post-owned; cache clears once attached', async () => {
    const received: IncomingMessage[] = [];
    const d = makeDispatcher(m => received.push(m), { botOpenId: BOT_OPEN_ID });
    const chatId = 'oc_cache_combo';
    const userId = 'ou_cache_user';

    // Un-mentioned group media goes into the pending cache, not to onMessage.
    await invokeMessage(d, {
      msgId: 'om_cached_img', chatId, userId,
      msgType: 'image', chatType: 'group',
      content: { image_key: 'k_cached_img' },
    });
    await invokeMessage(d, {
      msgId: 'om_cached_file', chatId, userId,
      msgType: 'file', chatType: 'group',
      content: { file_key: 'k_cached_file', file_name: 'report.pdf' },
    });
    expect(received).toHaveLength(0);

    // @bot post with two inline images: post extras must precede cached media,
    // because [Image N] anchors in the text belong to the post's own images.
    await invokeMessage(d, {
      msgId: 'om_post', chatId, userId,
      msgType: 'post', chatType: 'group',
      mentions: [{ id: { open_id: BOT_OPEN_ID } }],
      content: {
        content: [
          [{ tag: 'text', text: '对比这两张：' }],
          [{ tag: 'img', image_key: 'k_p1' }],
          [{ tag: 'img', image_key: 'k_p2' }],
        ],
      },
    });

    expect(received).toHaveLength(1);
    const m = received[0];
    expect(m.text).toBe('对比这两张：\n[Image 1]\n[Image 2]');
    expect(m.text).not.toContain('[Image 3]'); // cached media never claims an anchor
    expect(m.imageKey).toBe('k_p1');
    expect(m.extraMedia).toEqual([
      { messageId: 'om_post', imageKey: 'k_p2' },
      { messageId: 'om_cached_img', imageKey: 'k_cached_img', fileKey: undefined, fileName: undefined },
      { messageId: 'om_cached_file', imageKey: undefined, fileKey: 'k_cached_file', fileName: 'report.pdf' },
    ]);

    // Cache must be consumed: the next mentioned post carries only its own extras.
    await invokeMessage(d, {
      msgId: 'om_post2', chatId, userId,
      msgType: 'post', chatType: 'group',
      mentions: [{ id: { open_id: BOT_OPEN_ID } }],
      content: { content: [[{ tag: 'text', text: '再看一张' }, { tag: 'img', image_key: 'k_p3' }]] },
    });
    expect(received).toHaveLength(2);
    expect(received[1].imageKey).toBe('k_p3');
    expect(received[1].extraMedia).toBeUndefined();
  });
});
