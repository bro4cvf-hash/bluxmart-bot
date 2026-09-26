// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

require('ts-node/register/transpile-only');
const { PDFDocument, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const {
  TRANSCRIPT_LIMITS,
  TranscriptLimitError,
  buildTranscriptFile,
  isAllowedDiscordMediaUrl,
  pdfSafe,
  plainDiscordText,
} = require('../../src/lib/transcript.ts');

const FIXED_NOW = 1_700_000_000_000;
const META = {
  channelName: 'ticket-general-123',
  channelId: 'channel-123',
  openedByTag: 'opener',
  openedById: 'user-1',
  closedByTag: 'closer',
  closedById: 'user-2',
  closedAtHuman: 'Jan 1, 2024, 12:00 AM',
};
const MAPS = {
  users: new Map(),
  roles: new Map(),
  channels: new Map(),
};
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function message(index, content = '', extras = {}) {
  const id = String(1700000000000000000n + BigInt(index));
  const timestamp = FIXED_NOW + index;
  const attachments = extras.attachments instanceof Map
    ? extras.attachments
    : new Map((extras.attachments ?? []).map((value, attachmentIndex) => [String(attachmentIndex), value]));
  return {
    id,
    createdTimestamp: timestamp,
    createdAt: new Date(timestamp),
    content,
    author: {
      id: `user-${index}`,
      username: `user-${index}`,
      globalName: null,
      bot: false,
    },
    member: { displayName: `User ${index}` },
    mentions: { users: new Map() },
    embeds: extras.embeds ?? [],
    attachments,
    stickerItems: new Map(),
  };
}

function imageAttachment(url, name = 'image.png') {
  return {
    name,
    url,
    proxyURL: url,
    size: 32,
    contentType: 'image/png',
  };
}

function noNetworkOptions(overrides = {}) {
  return {
    now: () => FIXED_NOW,
    fetch: async () => {
      throw new Error('the test did not expect a network request');
    },
    ...overrides,
  };
}

function assertPdf(file) {
  assert.equal(Buffer.isBuffer(file.data), true);
  assert.equal(file.data.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(file.data.length > 0);
  assert.ok(file.data.length < TRANSCRIPT_LIMITS.discordUploadBytes);
  assert.ok(file.data.length <= TRANSCRIPT_LIMITS.maxPdfBytes);
  assert.match(file.name, /^transcript-.+\.pdf$/u);
}

function pdfText(file) {
  const document = PDFDocument.load(file.data);
  return document.then((loaded) => {
    const text = [];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        const decoded = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
        for (const match of decoded.matchAll(/<([0-9a-f]+)>\s*Tj/giu)) {
          text.push(Buffer.from(match[1], 'hex').toString('latin1'));
        }
      } catch {
        // Non-text streams (for example object streams) are irrelevant here.
      }
    }
    return text.join('\n');
  });
}

function streamedResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'image/png' } });
}

test('allows only exact HTTPS Discord media hosts', () => {
  for (const url of [
    'https://cdn.discordapp.com/attachments/1/2/image.png',
    'https://media.discordapp.net/attachments/1/2/image.png',
    'https://images-ext-1.discordapp.net/attachments/1/2/image.png',
  ]) {
    assert.equal(isAllowedDiscordMediaUrl(url), true, url);
  }

  for (const url of [
    'http://cdn.discordapp.com/image.png',
    'https://discordapp.com/image.png',
    'https://evil.discordapp.com/image.png',
    'https://cdn.discordapp.com.evil.example/image.png',
    'https://sub.cdn.discordapp.com/image.png',
    'https://user:password@cdn.discordapp.com/image.png',
    'https://@cdn.discordapp.com/image.png',
    'https://cdn.discordapp.com:444/image.png',
    'https://cdn.discordapp.com/\n/image.png',
    'https://cdn.discordapp.com/\u0000/image.png',
    'https://cdn.discordapp.com/%0a/image.png',
    'https://cdn.discordapp.com\\@evil.example/image.png',
  ]) {
    assert.equal(isAllowedDiscordMediaUrl(url), false, url);
  }
});

test('rejects an external image without invoking fetch', async () => {
  const calls = [];
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://images.example.invalid/image.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        throw new Error('external fetch reached');
      },
    }),
  );
  assert.equal(calls.length, 0);
  assertPdf(file);
});

test('handles redirects manually and revalidates the next hop', async () => {
  const calls = [];
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/image.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        assert.equal(init.redirect, 'manual');
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.discordapp.net/attachments/1/2/image.png' },
          });
        }
        return new Response(ONE_PIXEL_PNG, {
          headers: { 'content-length': String(ONE_PIXEL_PNG.length) },
        });
      },
    }),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.startsWith('https://cdn.discordapp.com/'), true);
  assert.equal(calls[1].input.startsWith('https://media.discordapp.net/'), true);
  assertPdf(file);
});

test('does not follow a redirect to an unapproved host', async () => {
  const calls = [];
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/image.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.discordapp.net.evil.example/image.png' },
        });
      },
    }),
  );
  assert.ok(calls.length > 0);
  assert.equal(calls.some((url) => !isAllowedDiscordMediaUrl(url)), false);
  assertPdf(file);
});

test('enforces Content-Length before reading an image body', async () => {
  let calls = 0;
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/image.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      limits: { maxImageBytes: 4, maxTotalImageBytes: 100 },
      fetch: async () => {
        calls += 1;
        return new Response(Buffer.alloc(5), { headers: { 'content-length': '5' } });
      },
    }),
  );
  assert.ok(calls > 0);
  assertPdf(file);
});

test('enforces the cumulative streamed image byte limit', async () => {
  let calls = 0;
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/image.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      limits: { maxImageBytes: 4, maxTotalImageBytes: 4 },
      fetch: async () => {
        calls += 1;
        return streamedResponse([[1, 1, 1], [1, 1, 1]]);
      },
    }),
  );
  assert.equal(calls, 1);
  assertPdf(file);
});

test('applies the image timeout while a response body is streaming', async () => {
  const body = new ReadableStream({
    start() {
      // Deliberately never close; the per-image signal must cancel the read.
    },
  });
  const started = Date.now();
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/stalled.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      limits: { imageTimeoutMs: 5 },
      fetch: async () => new Response(body),
    }),
  );
  assert.ok(Date.now() - started < 2000);
  assertPdf(file);
});

test('does not let an injected fetch ignore the per-image timeout', async () => {
  const started = Date.now();
  const file = await buildTranscriptFile(
    [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/pending.png')] })],
    MAPS,
    META,
    noNetworkOptions({
      limits: { imageTimeoutMs: 5 },
      fetch: async () => new Promise(() => {}),
    }),
  );
  assert.ok(Date.now() - started < 2000);
  assertPdf(file);
});

test('propagates the total deadline while an image body is stalled', async () => {
  const body = new ReadableStream({ start() {} });
  await assert.rejects(
    () => buildTranscriptFile(
      [message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/stalled.png')] })],
      MAPS,
      META,
      noNetworkOptions({
        limits: { totalTimeoutMs: 5, imageTimeoutMs: 100 },
        fetch: async () => new Response(body),
      }),
    ),
    (error) => error instanceof TranscriptLimitError && error.code === 'DEADLINE',
  );
});

test('caps image count and rejects oversized image dimensions', async () => {
  let calls = 0;
  const file = await buildTranscriptFile(
    [
      message(0, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/2/one.png')] }),
      message(1, '', { attachments: [imageAttachment('https://cdn.discordapp.com/attachments/1/3/two.png')] }),
    ],
    MAPS,
    META,
    noNetworkOptions({
      limits: { maxImages: 1, maxImageWidth: 10, maxImageHeight: 10, maxImagePixels: 100 },
      fetch: async () => {
        calls += 1;
        const oversized = Buffer.from(ONE_PIXEL_PNG);
        oversized.writeUInt32BE(5000, 16);
        return new Response(oversized, { headers: { 'content-length': String(oversized.length) } });
      },
    }),
  );
  assert.equal(calls, 4);
  assertPdf(file);
});

test('resolves role mentions from the role map, not the user map', () => {
  const text = plainDiscordText(
    '<@&123> <@!456> <#789>',
    new Map([['456', 'Alice#1234']]),
    new Map([['123', 'Support']]),
    new Map([['789', 'ticket-general']]),
  );
  assert.equal(text, '@Support @Alice #ticket-general');
});

test('uses a deterministic WinAnsi fallback for unsupported Unicode', async () => {
  assert.equal(pdfSafe('A🌍 café — “quoted”'), 'A? café - "quoted"');
  assert.equal(pdfSafe('⚠️'), '[warning]');
  const file = await buildTranscriptFile(
    [message(0, 'こんにちは 🌍')],
    MAPS,
    META,
    noNetworkOptions(),
  );
  assertPdf(file);
});

test('renders an empty history as a valid deterministic PDF', async () => {
  const file = await buildTranscriptFile([], MAPS, META, noNetworkOptions());
  const second = await buildTranscriptFile([], MAPS, META, noNetworkOptions());
  assertPdf(file);
  assert.deepEqual(file.data, second.data);
  const document = await PDFDocument.load(file.data);
  assert.equal(document.getPageCount(), 1);
});

test('rejects histories over the configured message bound', async () => {
  await assert.rejects(
    () => buildTranscriptFile(
      [message(0), message(1), message(2), message(3)],
      MAPS,
      META,
      noNetworkOptions({ limits: { maxMessages: 3 } }),
    ),
    (error) => error instanceof TranscriptLimitError && error.code === 'MESSAGE_LIMIT',
  );
});

test('rejects rendering that would exceed the page bound', async () => {
  const history = Array.from({ length: 80 }, (_, index) => message(index, 'long transcript line '.repeat(30)));
  await assert.rejects(
    () => buildTranscriptFile(history, MAPS, META, noNetworkOptions({ limits: { maxPages: 2 } })),
    (error) => error instanceof TranscriptLimitError && error.code === 'PAGE_LIMIT',
  );
});

test('fails clearly when the total deadline is exceeded', async () => {
  let tick = 0;
  await assert.rejects(
    () => buildTranscriptFile(
      [message(0)],
      MAPS,
      META,
      noNetworkOptions({
        now: () => {
          const value = tick;
          tick += 100;
          return value;
        },
        limits: { totalTimeoutMs: 10 },
      }),
    ),
    (error) => error instanceof TranscriptLimitError && error.code === 'DEADLINE',
  );
});

test('includes stable participant IDs and username history', async () => {
  const first = message(0, 'Opening message');
  first.author.id = 'user-42';
  first.author.username = 'OldName';
  first.member.displayName = 'OldName';

  const renamed = message(1, 'Message after rename');
  renamed.author.id = 'user-42';
  renamed.author.username = 'NewName';
  renamed.member.displayName = 'NewName';

  const file = await buildTranscriptFile(
    [first, renamed],
    MAPS,
    {
      ...META,
      openedByTag: 'OldName',
      openedById: 'user-42',
      closedByTag: 'Support',
      closedById: 'user-99',
    },
    noNetworkOptions(),
  );
  const text = await pdfText(file);
  assert.match(text, /PARTICIPANT IDENTITIES/u);
  assert.match(text, /user-42/u);
  assert.match(text, /user-99/u);
  assert.match(text, /OldName -> NewName/u);
  assertPdf(file);
});

test('sanitizes filenames and keeps the final PDF below the upload limit', async () => {
  const file = await buildTranscriptFile(
    [],
    MAPS,
    { ...META, channelName: '../../bad:*?\u0000\u202e' },
    noNetworkOptions(),
  );
  assertPdf(file);
  assert.equal(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202e]/u.test(file.name), false);
  assert.equal(file.name.includes('..'), false);
  assert.ok(Buffer.byteLength(file.name, 'utf8') <= 180);

  await assert.rejects(
    () => buildTranscriptFile([], MAPS, META, noNetworkOptions({ limits: { maxPdfBytes: 1 } })),
    (error) => error instanceof TranscriptLimitError && error.code === 'PDF_SIZE_LIMIT',
  );
});
