"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscriptLimitError = exports.TRANSCRIPT_LIMITS = void 0;
exports.pdfSafe = pdfSafe;
exports.plainDiscordText = plainDiscordText;
exports.isAllowedDiscordMediaUrl = isAllowedDiscordMediaUrl;
exports.buildTranscriptFile = buildTranscriptFile;
const pdf_lib_1 = require("pdf-lib");
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_TOP = PAGE_HEIGHT - PAGE_MARGIN;
const CONTENT_BOTTOM = 52;
const BODY_SIZE = 10;
const BODY_LINE_HEIGHT = 14;
const MESSAGE_TEXT_INDENT = 34;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
// Keep all generated work bounded. The PDF limit deliberately leaves room for
// Discord's multipart envelope and for the current 10 MiB attachment limit.
const MAX_MESSAGES = 2_000;
const MAX_PAGES = 250;
const TOTAL_DEADLINE_MS = 30_000;
const MAX_REDIRECTS = 4;
const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_IMAGE_CHUNKS = 100_000;
const MAX_TOTAL_IMAGE_BYTES = 5_500_000;
const MAX_IMAGE_WIDTH = 4_096;
const MAX_IMAGE_SOURCE_HEIGHT = 4_096;
const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_IMAGE_HEIGHT = 310;
const IMAGE_FETCH_TIMEOUT_MS = 12_000;
const MAX_PDF_BYTES = 8_000_000;
const DISCORD_UPLOAD_BYTES = 10 * 1024 * 1024;
exports.TRANSCRIPT_LIMITS = Object.freeze({
    maxMessages: MAX_MESSAGES,
    maxPages: MAX_PAGES,
    totalTimeoutMs: TOTAL_DEADLINE_MS,
    imageTimeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    maxImages: MAX_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES,
    maxImageWidth: MAX_IMAGE_WIDTH,
    maxImageHeight: MAX_IMAGE_SOURCE_HEIGHT,
    maxImagePixels: MAX_IMAGE_PIXELS,
    maxPdfBytes: MAX_PDF_BYTES,
    discordUploadBytes: DISCORD_UPLOAD_BYTES,
});
const COLORS = {
    ink: (0, pdf_lib_1.rgb)(0.11, 0.12, 0.15),
    body: (0, pdf_lib_1.rgb)(0.18, 0.2, 0.24),
    muted: (0, pdf_lib_1.rgb)(0.39, 0.42, 0.48),
    line: (0, pdf_lib_1.rgb)(0.86, 0.87, 0.89),
    blue: (0, pdf_lib_1.rgb)(0.12, 0.39, 0.82),
    paleBlue: (0, pdf_lib_1.rgb)(0.92, 0.95, 1),
    panel: (0, pdf_lib_1.rgb)(0.96, 0.965, 0.975),
    white: (0, pdf_lib_1.rgb)(1, 1, 1),
};
class TranscriptLimitError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'TranscriptLimitError';
    }
}
exports.TranscriptLimitError = TranscriptLimitError;
const TYPOGRAPHIC_REPLACEMENTS = {
    '\u00a0': ' ',
    '\u2018': "'",
    '\u2019': "'",
    '\u201a': ',',
    '\u201c': '"',
    '\u201d': '"',
    '\u201e': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2022': '*',
    '\u2026': '...',
    '\u202f': ' ',
    '\u2039': '<',
    '\u203a': '>',
};
const EMOJI_REPLACEMENTS = {
    '\u2705': '[OK]',
    '\u274c': '[X]',
    '\u26a0\ufe0f': '[warning]',
    '\u26a0': '[warning]',
    '\U0001f512': '[locked]',
    '\U0001f4e6': '[package]',
    '\U0001f3ab': '[ticket]',
    '\U0001f440': '[eyes]',
};
const WIN_ANSI_EXTRA = new Set([
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
    0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);
/** Keep output safe for PDF's built-in WinAnsi fonts. */
function pdfSafe(value) {
    let out = '';
    const normalized = value.normalize('NFKC');
    for (let index = 0; index < normalized.length;) {
        const code = normalized.codePointAt(index) ?? 0;
        const original = String.fromCodePoint(code);
        if (original === '\u26a0' && normalized.startsWith('\ufe0f', index + original.length)) {
            out += '[warning]';
            index += original.length + 1;
            continue;
        }
        const char = TYPOGRAPHIC_REPLACEMENTS[original] ?? EMOJI_REPLACEMENTS[original];
        if (char !== undefined) {
            out += char;
            index += original.length;
            continue;
        }
        if (original === '\t') {
            out += '    ';
        }
        else if (original === '\n' || original === '\r') {
            out += ' ';
        }
        else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
            out += original;
        }
        else if (WIN_ANSI_EXTRA.has(code)) {
            out += original;
        }
        else {
            out += '?';
        }
        index += original.length;
    }
    return out;
}
function cleanTag(tag) {
    return tag.replace(/#0$/, '').split('#')[0];
}
function displayNameFor(message) {
    const anyMessage = message;
    const memberName = anyMessage?.member?.displayName;
    const globalName = message.author?.globalName;
    const raw = (memberName ?? globalName ?? message.author.username ?? 'unknown-user').trim() || 'unknown-user';
    return cleanTag(raw);
}
/** Turn Discord markdown/mentions into readable plain text for the PDF. */
function plainDiscordText(content, users, roles, channels) {
    return content
        .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/<@&(\d+)>/g, (_match, id) => `@${roles.get(id) ?? 'deleted-role'}`)
        .replace(/<@!?(\d+)>/g, (_match, id) => `@${cleanTag(users.get(id) ?? 'unknown-user')}`)
        .replace(/<#(\d+)>/g, (_match, id) => `#${channels.get(id) ?? 'deleted-channel'}`)
        .replace(/<a?:([^:>]+):\d+>/g, '$1')
        .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, '[Discord timestamp]')
        .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/\|\|([^|]+)\|\|/g, '[$1]')
        .replace(/\\([\\`*_[\]{}()#+\-.!|>~])/g, '$1');
}
function fmtFullTime(date) {
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC',
    });
}
function isImageUrl(url, contentType) {
    return contentType.toLowerCase().startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(url);
}
function isVideoUrl(url, contentType) {
    return contentType.toLowerCase().startsWith('video/') || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url);
}
function normalizeMessages(messages, maps, deadline) {
    const ordered = [...messages].sort((left, right) => {
        const timeDifference = left.createdTimestamp - right.createdTimestamp;
        if (timeDifference !== 0)
            return timeDifference;
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const users = new Map(maps.users);
    const roles = new Map(maps.roles);
    const channels = new Map(maps.channels);
    // Resolve every author before rendering any mentions.
    for (const message of ordered) {
        deadline?.check('message normalization');
        if (!users.has(message.author.id))
            users.set(message.author.id, displayNameFor(message));
        for (const [id, user] of message.mentions.users) {
            if (!users.has(id))
                users.set(id, cleanTag(user.globalName ?? user.username ?? user.tag ?? 'unknown-user'));
        }
    }
    return ordered.map((message) => {
        deadline?.check('message normalization');
        const anyMessage = message;
        const embeds = message.embeds.map((embed) => ({
            author: String(embed.author?.name ?? ''),
            title: String(embed.title ?? ''),
            url: String(embed.url ?? ''),
            description: String(embed.description ?? ''),
            fields: (embed.fields ?? []).map((field) => ({
                name: String(field.name ?? ''),
                value: String(field.value ?? ''),
            })),
            imageUrl: String(embed.image?.url ?? ''),
            thumbnailUrl: String(embed.thumbnail?.url ?? ''),
            footer: String(embed.footer?.text ?? ''),
            color: embed.color ? (0, pdf_lib_1.rgb)(((embed.color >> 16) & 0xff) / 255, ((embed.color >> 8) & 0xff) / 255, (embed.color & 0xff) / 255) : COLORS.blue,
        }));
        const attachments = [...message.attachments.values()].map((attachment) => ({
            name: attachment.name,
            url: attachment.url,
            proxyUrl: attachment.proxyURL || attachment.url,
            size: attachment.size,
            isImage: isImageUrl(attachment.url, attachment.contentType ?? ''),
            isVideo: isVideoUrl(attachment.url, attachment.contentType ?? ''),
        }));
        const stickers = [...(anyMessage.stickerItems?.values?.() ?? [])].map((sticker) => ({
            name: String(sticker.name ?? 'sticker'),
            url: `https://cdn.discordapp.com/stickers/${sticker.id}.png`,
        }));
        return {
            id: message.id,
            authorId: message.author.id,
            // Keep the name attached to each message so a later username change does
            // not erase earlier identities. The stable authorId remains authoritative.
            authorName: displayNameFor(message),
            isBot: message.author.bot,
            createdAt: message.createdAt,
            content: plainDiscordText(message.content, users, roles, channels),
            embeds,
            attachments,
            stickers,
        };
    });
}
// Deliberately an exact allowlist; suffix matching would permit attacker-controlled hosts.
const DISCORD_MEDIA_HOSTS = new Set([
    'cdn.discordapp.com',
    'media.discordapp.net',
    'images-ext-1.discordapp.net',
    'images-ext-2.discordapp.net',
]);
const MAX_MEDIA_URL_LENGTH = 8_192;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
function hasControlCharacters(value) {
    return typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}
/** Parse only exact, credential-free HTTPS Discord media hosts. */
function parseDiscordMediaUrl(value) {
    if (typeof value !== 'string' ||
        value.length > MAX_MEDIA_URL_LENGTH ||
        value.includes('\\') ||
        hasControlCharacters(value) ||
        !/^https:\/\//i.test(value))
        return null;
    try {
        const authority = value.match(/^https:\/\/([^/?#]*)/iu)?.[1] ?? '';
        if (authority.includes('@'))
            return null;
        const decodedValue = decodeURIComponent(value);
        if (hasControlCharacters(decodedValue))
            return null;
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' ||
            parsed.username !== '' ||
            parsed.password !== '' ||
            parsed.port !== '' ||
            !DISCORD_MEDIA_HOSTS.has(parsed.hostname.toLowerCase())) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function isAllowedDiscordMediaUrl(value) {
    return parseDiscordMediaUrl(value) !== null;
}
function discordImageVariant(url, width, quality) {
    const parsed = parseDiscordMediaUrl(url);
    if (!parsed)
        return null;
    parsed.searchParams.set('format', 'jpg');
    parsed.searchParams.set('quality', String(quality));
    parsed.searchParams.set('width', String(width));
    const variant = parsed.toString();
    return parseDiscordMediaUrl(variant) ? variant : null;
}
function detectImageKind(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'jpg';
    if (data.length >= 8 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
        data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
        return 'png';
    }
    return null;
}
/** Read dimensions before pdf-lib allocates/decompresses an image. */
function readImageDimensions(data, kind) {
    if (kind === 'png') {
        if (data.length < 24 ||
            data.readUInt32BE(8) !== 13 ||
            data.toString('ascii', 12, 16) !== 'IHDR') {
            return null;
        }
        const width = data.readUInt32BE(16);
        const height = data.readUInt32BE(20);
        return width > 0 && height > 0 ? { width, height } : null;
    }
    let offset = 2;
    while (offset < data.length) {
        while (offset < data.length && data[offset] === 0xff)
            offset += 1;
        if (offset >= data.length)
            return null;
        const marker = data[offset];
        offset += 1;
        if (marker === 0x00 || marker === 0xd9)
            return null;
        if (marker === 0xda)
            return null;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8))
            continue;
        if (offset + 2 > data.length)
            return null;
        const segmentLength = data.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > data.length)
            return null;
        const segmentStart = offset + 2;
        const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isStartOfFrame) {
            if (segmentLength < 7)
                return null;
            const height = data.readUInt16BE(segmentStart + 1);
            const width = data.readUInt16BE(segmentStart + 3);
            return width > 0 && height > 0 ? { width, height } : null;
        }
        offset += segmentLength;
    }
    return null;
}
function boundedLimit(overrides, key, minimum) {
    const hardMaximum = exports.TRANSCRIPT_LIMITS[key];
    const value = overrides[key] ?? hardMaximum;
    if (!Number.isSafeInteger(value) || value < minimum || value > hardMaximum) {
        throw new RangeError(`${key} must be an integer between ${minimum} and ${hardMaximum}.`);
    }
    return value;
}
function resolveTranscriptLimits(overrides = {}) {
    return {
        maxMessages: boundedLimit(overrides, 'maxMessages', 0),
        maxPages: boundedLimit(overrides, 'maxPages', 1),
        totalTimeoutMs: boundedLimit(overrides, 'totalTimeoutMs', 1),
        imageTimeoutMs: boundedLimit(overrides, 'imageTimeoutMs', 1),
        maxRedirects: boundedLimit(overrides, 'maxRedirects', 0),
        maxImages: boundedLimit(overrides, 'maxImages', 0),
        maxImageBytes: boundedLimit(overrides, 'maxImageBytes', 0),
        maxTotalImageBytes: boundedLimit(overrides, 'maxTotalImageBytes', 0),
        maxImageWidth: boundedLimit(overrides, 'maxImageWidth', 1),
        maxImageHeight: boundedLimit(overrides, 'maxImageHeight', 1),
        maxImagePixels: boundedLimit(overrides, 'maxImagePixels', 1),
        maxPdfBytes: boundedLimit(overrides, 'maxPdfBytes', 1),
    };
}
class TranscriptDeadline {
    timeoutMs;
    now;
    signal;
    controller = new AbortController();
    startedAt;
    timer;
    expired = false;
    constructor(timeoutMs, now) {
        this.timeoutMs = timeoutMs;
        this.now = now;
        this.startedAt = this.readNow();
        this.signal = this.controller.signal;
        this.timer = setTimeout(() => this.expire(), this.timeoutMs);
    }
    readNow() {
        const value = this.now();
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new RangeError('Transcript clock must return a finite number.');
        }
        return value;
    }
    check(stage) {
        if (this.expired || this.controller.signal.aborted || this.readNow() - this.startedAt >= this.timeoutMs) {
            this.expire();
            throw new TranscriptLimitError('DEADLINE', `Transcript generation exceeded the ${this.timeoutMs} ms total deadline (${stage}).`);
        }
    }
    expire() {
        if (this.expired)
            return;
        this.expired = true;
        this.controller.abort();
    }
    dispose() {
        clearTimeout(this.timer);
    }
}
class ImageTotalLimitError extends Error {
}
class ImageResponseLimitError extends Error {
}
class ImageByteBudget {
    maximum;
    used = 0;
    constructor(maximum) {
        this.maximum = maximum;
    }
    get remaining() {
        return Math.max(0, this.maximum - this.used);
    }
    consume(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximum - this.used) {
            throw new ImageTotalLimitError('Transcript image byte budget exceeded.');
        }
        this.used += bytes;
    }
}
function createTranscriptRuntime(options) {
    const now = options.now ?? Date.now;
    const limits = resolveTranscriptLimits(options.limits);
    const selectedFetch = options.fetch ?? (typeof globalThis.fetch === 'function'
        ? (input, init) => globalThis.fetch(input, init)
        : undefined);
    const deadline = new TranscriptDeadline(limits.totalTimeoutMs, now);
    const runtime = {
        fetch: selectedFetch,
        now,
        limits,
        deadline,
        imageBudget: new ImageByteBudget(limits.maxTotalImageBytes),
        async withImageDeadline(operation) {
            deadline.check('image fetch');
            const controller = new AbortController();
            const abortForDeadline = () => controller.abort();
            deadline.signal.addEventListener('abort', abortForDeadline, { once: true });
            if (deadline.signal.aborted)
                abortForDeadline();
            const timer = setTimeout(() => controller.abort(), limits.imageTimeoutMs);
            try {
                return await operation(controller.signal);
            }
            finally {
                clearTimeout(timer);
                deadline.signal.removeEventListener('abort', abortForDeadline);
            }
        },
    };
    return runtime;
}
function parseContentLength(headers) {
    const raw = headers.get('content-length');
    if (raw === null)
        return null;
    const value = raw.trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(value))
        throw new ImageResponseLimitError('Invalid Content-Length.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new ImageResponseLimitError('Content-Length is too large.');
    return parsed;
}
async function cancelResponseBody(response, signal) {
    try {
        const cancellation = response.body?.cancel();
        if (signal && cancellation)
            await awaitWithAbort(() => Promise.resolve(cancellation), signal);
        else
            await cancellation;
    }
    catch {
        // The response is being discarded; cancellation is best-effort.
    }
}
function awaitWithAbort(operation, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const succeed = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => fail(new ImageResponseLimitError('Image request timed out.'));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            void Promise.resolve(operation()).then(succeed, fail);
        }
        catch (error) {
            fail(error);
        }
    });
}
function readStreamChunk(reader, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const succeed = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => fail(new ImageResponseLimitError('Image request timed out.'));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            void Promise.resolve(reader.read()).then(succeed, fail);
        }
        catch (error) {
            fail(error);
        }
    });
}
async function readImageResponse(response, runtime, budget, signal) {
    if (signal.aborted) {
        runtime.deadline.check('image download');
        throw new ImageResponseLimitError('Image request timed out.');
    }
    const advertisedSize = parseContentLength(response.headers);
    const requestLimit = runtime.limits.maxImageBytes;
    const totalRemaining = budget.remaining;
    const allowedSize = Math.min(requestLimit, totalRemaining);
    if (advertisedSize !== null && advertisedSize > allowedSize) {
        if (advertisedSize > totalRemaining)
            throw new ImageTotalLimitError('Transcript image byte budget exceeded.');
        throw new ImageResponseLimitError('Image Content-Length exceeds the per-image limit.');
    }
    const reader = response.body?.getReader();
    if (!reader)
        return null;
    const chunks = [];
    let received = 0;
    let chunkCount = 0;
    let completed = false;
    try {
        while (true) {
            if (signal.aborted) {
                runtime.deadline.check('image download');
                throw new ImageResponseLimitError('Image request timed out.');
            }
            runtime.deadline.check('image download');
            const { done, value } = await readStreamChunk(reader, signal);
            if (signal.aborted) {
                runtime.deadline.check('image download');
                throw new ImageResponseLimitError('Image request timed out.');
            }
            if (done)
                break;
            chunkCount += 1;
            if (chunkCount > MAX_IMAGE_CHUNKS)
                throw new ImageResponseLimitError('Image stream has too many chunks.');
            if (!value || value.byteLength === 0)
                continue;
            const chunkLength = value.byteLength;
            budget.consume(chunkLength);
            received += chunkLength;
            if (received > requestLimit)
                throw new ImageResponseLimitError('Streamed image exceeds the per-image limit.');
            chunks.push(Buffer.from(value));
        }
        completed = true;
        return received > 0 ? Buffer.concat(chunks, received) : null;
    }
    finally {
        if (!completed) {
            try {
                const cancellation = reader.cancel();
                await awaitWithAbort(() => Promise.resolve(cancellation), signal);
            }
            catch {
                // The per-request abort signal also stops an in-flight Discord response.
            }
        }
        try {
            reader.releaseLock();
        }
        catch {
            // A failed/aborted stream may already have released its reader.
        }
    }
}
async function fetchImage(url, runtime, budget) {
    let currentUrl = url;
    for (let redirects = 0; redirects <= runtime.limits.maxRedirects; redirects += 1) {
        runtime.deadline.check('image fetch');
        const parsed = parseDiscordMediaUrl(currentUrl);
        if (!parsed || !runtime.fetch)
            return null;
        let outcome;
        try {
            outcome = await runtime.withImageDeadline(async (signal) => {
                const response = await awaitWithAbort(() => runtime.fetch(parsed.toString(), {
                    redirect: 'manual',
                    signal,
                    headers: { Accept: 'image/jpeg,image/png' },
                }), signal);
                if (response.url && !parseDiscordMediaUrl(response.url)) {
                    await cancelResponseBody(response, signal);
                    return { kind: 'unavailable' };
                }
                if (REDIRECT_STATUSES.has(response.status)) {
                    const location = response.headers.get('location');
                    await cancelResponseBody(response, signal);
                    return { kind: 'redirect', location };
                }
                if (!response.ok) {
                    await cancelResponseBody(response, signal);
                    return { kind: 'unavailable' };
                }
                try {
                    const data = await readImageResponse(response, runtime, budget, signal);
                    return { kind: 'data', data };
                }
                catch (error) {
                    await cancelResponseBody(response, signal);
                    runtime.deadline.check('image download');
                    if (error instanceof ImageTotalLimitError)
                        throw error;
                    return { kind: 'unavailable' };
                }
            });
        }
        catch (error) {
            runtime.deadline.check('image fetch');
            if (error instanceof ImageTotalLimitError)
                throw error;
            return null;
        }
        runtime.deadline.check('image fetch');
        if (outcome.kind === 'unavailable')
            return null;
        if (outcome.kind === 'data')
            return outcome.data;
        if (redirects >= runtime.limits.maxRedirects ||
            outcome.location === null ||
            outcome.location.length > MAX_MEDIA_URL_LENGTH ||
            hasControlCharacters(outcome.location))
            return null;
        let next;
        try {
            next = new URL(outcome.location, parsed);
        }
        catch {
            return null;
        }
        const normalizedNext = next.toString();
        if (!parseDiscordMediaUrl(normalizedNext))
            return null;
        currentUrl = normalizedNext;
    }
    return null;
}
async function findEmbeddableImage(url, runtime) {
    runtime.deadline.check('image lookup');
    const variants = [
        discordImageVariant(url, 1600, 82),
        discordImageVariant(url, 1200, 65),
        discordImageVariant(url, 900, 50),
    ].filter((variant) => variant !== null);
    // Discord's media endpoints can return a normal JPEG/PNG directly too.
    const candidates = variants.length > 0 ? [...variants, url] : [url];
    let dimensionsExceeded = false;
    for (const candidate of candidates) {
        if (runtime.imageBudget.remaining === 0)
            return { overBudget: true };
        let data;
        try {
            data = await fetchImage(candidate, runtime, runtime.imageBudget);
        }
        catch (error) {
            if (error instanceof ImageTotalLimitError)
                return { overBudget: true };
            throw error;
        }
        if (!data)
            continue;
        const kind = detectImageKind(data);
        if (!kind)
            continue;
        const dimensions = readImageDimensions(data, kind);
        if (!dimensions)
            continue;
        if (dimensions.width > runtime.limits.maxImageWidth ||
            dimensions.height > runtime.limits.maxImageHeight ||
            dimensions.width > Math.floor(runtime.limits.maxImagePixels / dimensions.height)) {
            dimensionsExceeded = true;
            continue;
        }
        return { data, kind, dimensions };
    }
    return dimensionsExceeded ? { dimensionsExceeded: true } : { unavailable: true };
}
function truncateToWidth(value, font, size, maxWidth) {
    if (font.widthOfTextAtSize(value, size) <= maxWidth)
        return value;
    let output = value;
    while (output.length > 1 && font.widthOfTextAtSize(`${output}...`, size) > maxWidth) {
        output = output.slice(0, -1);
    }
    return `${output}...`;
}
function ticketTitle(channelName) {
    const kind = channelName.match(/^ticket-([a-z0-9_]+)-/i)?.[1];
    if (!kind)
        return 'Support ticket';
    return `${kind.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())} ticket`;
}
function fmtShortTime(date) {
    return date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
}
function initialFor(name) {
    return Array.from(pdfSafe(name).trim())[0]?.toUpperCase() || '?';
}
class PdfTranscriptRenderer {
    meta;
    includeImages;
    runtime;
    doc;
    regular;
    bold;
    italic;
    imageCache = new Map();
    page;
    y;
    imageSlots = 0;
    constructor(doc, regular, bold, italic, meta, includeImages, runtime) {
        this.meta = meta;
        this.includeImages = includeImages;
        this.runtime = runtime;
        this.doc = doc;
        this.regular = regular;
        this.bold = bold;
        this.italic = italic;
        this.page = this.addPage();
        this.y = CONTENT_TOP;
    }
    static async create(meta, includeImages, runtime) {
        runtime.deadline.check('PDF initialization');
        const doc = await pdf_lib_1.PDFDocument.create();
        const [regular, bold, italic] = await Promise.all([
            doc.embedFont(pdf_lib_1.StandardFonts.Helvetica),
            doc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold),
            doc.embedFont(pdf_lib_1.StandardFonts.HelveticaOblique),
        ]);
        runtime.deadline.check('PDF initialization');
        const createdAt = new Date(runtime.now());
        if (!Number.isFinite(createdAt.getTime()))
            throw new RangeError('Transcript clock returned an invalid date.');
        doc.setTitle(`Ticket closed: #${meta.channelName}`);
        doc.setAuthor('Bluxmart');
        doc.setCreator('Bluxmart Discord Ticket System');
        doc.setProducer('pdf-lib');
        doc.setSubject(`Complete transcript for ticket #${meta.channelName}`);
        doc.setKeywords(['ticket', 'transcript', 'discord', meta.channelName]);
        doc.setCreationDate(createdAt);
        doc.setModificationDate(createdAt);
        return new PdfTranscriptRenderer(doc, regular, bold, italic, meta, includeImages, runtime);
    }
    addPage() {
        this.runtime.deadline.check('PDF page generation');
        if (this.doc.getPageCount() >= this.runtime.limits.maxPages) {
            throw new TranscriptLimitError('PAGE_LIMIT', `Transcript exceeds the ${this.runtime.limits.maxPages} page limit.`);
        }
        return this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    }
    addLink(x, y, width, height, url) {
        if (hasControlCharacters(url) || /^https?:\/\/[^/?#]*@/iu.test(url) || url.includes('\\'))
            return;
        let safeUrl;
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '')
                return;
            safeUrl = parsed.toString();
        }
        catch {
            return;
        }
        const annotation = this.doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x, y, x + Math.max(1, width), y + Math.max(1, height)],
            Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: pdf_lib_1.PDFString.of(safeUrl) },
        });
        this.page.node.addAnnot(this.doc.context.register(annotation));
    }
    newPage() {
        this.page = this.addPage();
        this.page.drawText('BLUXMART SUPPORT', {
            x: PAGE_MARGIN,
            y: CONTENT_TOP,
            size: 7.5,
            font: this.bold,
            color: COLORS.muted,
        });
        const runningTitle = pdfSafe(ticketTitle(this.meta.channelName));
        const titleWidth = this.regular.widthOfTextAtSize(runningTitle, 7.5);
        this.page.drawText(runningTitle, {
            x: PAGE_WIDTH - PAGE_MARGIN - titleWidth,
            y: CONTENT_TOP,
            size: 7.5,
            font: this.regular,
            color: COLORS.muted,
        });
        this.page.drawLine({
            start: { x: PAGE_MARGIN, y: CONTENT_TOP - 9 },
            end: { x: PAGE_WIDTH - PAGE_MARGIN, y: CONTENT_TOP - 9 },
            thickness: 0.7,
            color: COLORS.line,
        });
        this.y = CONTENT_TOP - 28;
    }
    ensureSpace(height) {
        if (this.y - height < CONTENT_BOTTOM)
            this.newPage();
    }
    wrapLine(line, font, size, maxWidth) {
        if (line === '')
            return [''];
        const output = [];
        let current = '';
        for (const char of line) {
            const candidate = current + char;
            if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
                output.push(current);
                current = char === ' ' ? '' : char;
            }
            else {
                current = candidate;
            }
        }
        if (current !== '' || output.length === 0)
            output.push(current);
        return output;
    }
    drawWrapped(text, options = {}) {
        const font = options.font ?? this.regular;
        const size = options.size ?? BODY_SIZE;
        const color = options.color ?? COLORS.body;
        const indent = options.indent ?? 0;
        const lineHeight = options.lineHeight ?? size * 1.35;
        const maxWidth = Math.max(20, CONTENT_WIDTH - indent);
        const lines = [];
        for (const sourceLine of pdfSafe(text).replace(/\r\n?/g, '\n').split('\n')) {
            lines.push(...this.wrapLine(sourceLine, font, size, maxWidth));
        }
        for (const line of lines) {
            this.runtime.deadline.check('text layout');
            this.ensureSpace(lineHeight);
            const x = PAGE_MARGIN + indent;
            this.page.drawText(line, { x, y: this.y, size, font, color });
            if (options.link && line) {
                this.addLink(x, this.y - 2, font.widthOfTextAtSize(line, size), size + 4, options.link);
            }
            this.y -= lineHeight;
        }
    }
    drawHero() {
        const panelHeight = 132;
        const panelY = this.y - panelHeight;
        const panelX = PAGE_MARGIN;
        this.page.drawRectangle({
            x: panelX,
            y: panelY,
            width: CONTENT_WIDTH,
            height: panelHeight,
            color: COLORS.ink,
        });
        this.page.drawText('SUPPORT TICKET', {
            x: panelX + 20,
            y: this.y - 25,
            size: 7.5,
            font: this.bold,
            color: (0, pdf_lib_1.rgb)(0.66, 0.73, 1),
        });
        this.page.drawRectangle({
            x: PAGE_WIDTH - PAGE_MARGIN - 76,
            y: this.y - 36,
            width: 56,
            height: 17,
            color: (0, pdf_lib_1.rgb)(0.18, 0.31, 0.66),
        });
        this.page.drawText('CLOSED', {
            x: PAGE_WIDTH - PAGE_MARGIN - 63,
            y: this.y - 31,
            size: 7,
            font: this.bold,
            color: COLORS.white,
        });
        this.page.drawText(pdfSafe(ticketTitle(this.meta.channelName)), {
            x: panelX + 20,
            y: this.y - 52,
            size: 17,
            font: this.bold,
            color: COLORS.white,
        });
        this.page.drawText(pdfSafe(`#${this.meta.channelName}`), {
            x: panelX + 20,
            y: this.y - 69,
            size: 8,
            font: this.regular,
            color: (0, pdf_lib_1.rgb)(0.7, 0.72, 0.77),
            maxWidth: CONTENT_WIDTH - 40,
        });
        const columns = [
            { x: panelX + 20, label: 'OPENED BY', value: `@${cleanTag(this.meta.openedByTag)}` },
            { x: panelX + 282, label: 'CLOSED BY', value: `@${cleanTag(this.meta.closedByTag)}` },
        ];
        for (const column of columns) {
            this.page.drawText(column.label, {
                x: column.x,
                y: this.y - 94,
                size: 6.5,
                font: this.bold,
                color: (0, pdf_lib_1.rgb)(0.6, 0.63, 0.69),
            });
            this.page.drawText(pdfSafe(column.value), {
                x: column.x,
                y: this.y - 108,
                size: 8.5,
                font: this.regular,
                color: COLORS.white,
                maxWidth: 235,
            });
        }
        this.page.drawText('CLOSED', {
            x: panelX + 20,
            y: this.y - 122,
            size: 6.5,
            font: this.bold,
            color: (0, pdf_lib_1.rgb)(0.6, 0.63, 0.69),
        });
        this.page.drawText(pdfSafe(this.meta.closedAtHuman), {
            x: panelX + 68,
            y: this.y - 122,
            size: 8.2,
            font: this.regular,
            color: COLORS.white,
        });
        this.page.drawText('MESSAGES', {
            x: panelX + 420,
            y: this.y - 122,
            size: 6.5,
            font: this.bold,
            color: (0, pdf_lib_1.rgb)(0.6, 0.63, 0.69),
        });
        this.page.drawText(String(this.meta.count), {
            x: panelX + 478,
            y: this.y - 122,
            size: 8.2,
            font: this.regular,
            color: COLORS.white,
        });
        this.y = panelY - 22;
    }
    async embedImage(url) {
        const cached = this.imageCache.get(url);
        if (cached)
            return cached;
        if (!this.includeImages) {
            const result = { unavailable: true };
            this.imageCache.set(url, result);
            return result;
        }
        if (this.imageSlots >= this.runtime.limits.maxImages) {
            const result = { overBudget: true };
            this.imageCache.set(url, result);
            return result;
        }
        this.imageSlots += 1;
        const found = await findEmbeddableImage(url, this.runtime);
        if ('unavailable' in found) {
            const result = { unavailable: true };
            this.imageCache.set(url, result);
            return result;
        }
        if ('overBudget' in found) {
            const result = { overBudget: true };
            this.imageCache.set(url, result);
            return result;
        }
        if ('dimensionsExceeded' in found) {
            const result = { dimensionsExceeded: true };
            this.imageCache.set(url, result);
            return result;
        }
        try {
            this.runtime.deadline.check('PDF image embedding');
            const image = found.kind === 'jpg'
                ? await this.doc.embedJpg(found.data)
                : await this.doc.embedPng(found.data);
            this.runtime.deadline.check('PDF image embedding');
            if (image.width > this.runtime.limits.maxImageWidth ||
                image.height > this.runtime.limits.maxImageHeight ||
                image.width > Math.floor(this.runtime.limits.maxImagePixels / image.height)) {
                const result = { dimensionsExceeded: true };
                this.imageCache.set(url, result);
                return result;
            }
            const result = { image, bytes: found.data.length };
            this.imageCache.set(url, result);
            return result;
        }
        catch {
            this.runtime.deadline.check('PDF image embedding');
            const result = { unavailable: true };
            this.imageCache.set(url, result);
            return result;
        }
    }
    drawLinkCard(title, detail, url, indent) {
        this.ensureSpace(50);
        const boxX = PAGE_MARGIN + indent;
        const boxWidth = CONTENT_WIDTH - indent;
        const boxY = this.y - 38;
        this.page.drawRectangle({
            x: boxX,
            y: boxY,
            width: boxWidth,
            height: 38,
            color: COLORS.paleBlue,
        });
        this.page.drawRectangle({
            x: boxX,
            y: boxY,
            width: 3,
            height: 38,
            color: COLORS.blue,
        });
        this.page.drawText(truncateToWidth(pdfSafe(title), this.bold, 9, boxWidth - 20), {
            x: boxX + 12,
            y: this.y - 15,
            size: 9,
            font: this.bold,
            color: COLORS.ink,
        });
        this.page.drawText(truncateToWidth(pdfSafe(detail), this.regular, 7.5, boxWidth - 20), {
            x: boxX + 12,
            y: this.y - 29,
            size: 7.5,
            font: this.regular,
            color: COLORS.blue,
        });
        this.addLink(boxX, boxY, boxWidth, 38, url);
        this.y = boxY - 10;
    }
    async drawImage(sourceUrl, label, maxHeight = MAX_IMAGE_HEIGHT, fetchUrl = sourceUrl, baseIndent = MESSAGE_TEXT_INDENT) {
        this.runtime.deadline.check('image rendering');
        const embedded = await this.embedImage(fetchUrl);
        const contentIndent = baseIndent + 12;
        if (!('image' in embedded)) {
            const reason = 'overBudget' in embedded
                ? 'Omitted to keep the PDF within Discord upload limits'
                : 'dimensionsExceeded' in embedded
                    ? 'Preview dimensions exceed safety limits'
                    : 'Preview unavailable';
            this.drawLinkCard(label, `${reason} - open original`, sourceUrl, contentIndent);
            return;
        }
        const scale = embedded.image.scaleToFit(CONTENT_WIDTH - contentIndent - 12, maxHeight);
        const imageX = PAGE_MARGIN + contentIndent;
        this.ensureSpace(scale.height + 32);
        this.drawWrapped(label, { size: 7.5, color: COLORS.muted, indent: contentIndent, lineHeight: 10 });
        const imageY = this.y - 4 - scale.height;
        this.page.drawRectangle({
            x: imageX - 3,
            y: imageY - 3,
            width: scale.width + 6,
            height: scale.height + 6,
            color: COLORS.panel,
        });
        this.page.drawImage(embedded.image, { x: imageX, y: imageY, width: scale.width, height: scale.height });
        this.addLink(imageX, imageY, scale.width, scale.height, sourceUrl);
        this.y = imageY - 13;
    }
    async drawAttachment(attachment) {
        this.runtime.deadline.check('attachment rendering');
        if (attachment.isImage) {
            await this.drawImage(attachment.url, attachment.name || 'Image attachment', 330, attachment.proxyUrl);
            return;
        }
        const size = attachment.size > 0 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : 'Unknown size';
        const kind = attachment.isVideo ? 'Video' : 'File';
        this.drawLinkCard(`${kind}: ${attachment.name || 'attachment'}`, `${size} - open original`, attachment.url, MESSAGE_TEXT_INDENT + 12);
    }
    async drawEmbed(embed) {
        this.runtime.deadline.check('embed rendering');
        this.ensureSpace(30);
        const indent = MESSAGE_TEXT_INDENT + 12;
        this.page.drawRectangle({
            x: PAGE_MARGIN + MESSAGE_TEXT_INDENT,
            y: this.y - 3,
            width: 2,
            height: 12,
            color: embed.color,
        });
        const label = embed.author ? `Embed - ${embed.author}` : 'Embed';
        this.drawWrapped(label, { font: this.bold, size: 7, color: COLORS.blue, indent, lineHeight: 10 });
        if (embed.title) {
            this.drawWrapped(embed.title, { font: this.bold, size: 10, indent, lineHeight: 13, link: embed.url || undefined });
        }
        if (embed.description)
            this.drawWrapped(embed.description, { size: 9, indent, lineHeight: 12 });
        for (const field of embed.fields) {
            if (field.name)
                this.drawWrapped(field.name, { font: this.bold, size: 8.7, indent, lineHeight: 11 });
            if (field.value)
                this.drawWrapped(field.value, { size: 8.7, indent, lineHeight: 11.5 });
        }
        if (embed.thumbnailUrl)
            await this.drawImage(embed.thumbnailUrl, 'Embed thumbnail', 170, embed.thumbnailUrl, MESSAGE_TEXT_INDENT);
        if (embed.imageUrl)
            await this.drawImage(embed.imageUrl, 'Embed image', MAX_IMAGE_HEIGHT, embed.imageUrl, MESSAGE_TEXT_INDENT);
        if (embed.footer)
            this.drawWrapped(embed.footer, { size: 7.5, color: COLORS.muted, indent, lineHeight: 10 });
        this.y -= 8;
    }
    async drawMessage(message, grouped) {
        const time = pdfSafe(fmtFullTime(message.createdAt));
        const timeWidth = this.regular.widthOfTextAtSize(time, 7.5);
        if (grouped) {
            this.ensureSpace(25);
            const shortTime = pdfSafe(fmtShortTime(message.createdAt));
            const shortWidth = this.regular.widthOfTextAtSize(shortTime, 6.5);
            this.page.drawText(shortTime, {
                x: PAGE_MARGIN + MESSAGE_TEXT_INDENT - 4 - shortWidth,
                y: this.y,
                size: 6.5,
                font: this.regular,
                color: COLORS.muted,
            });
            this.y -= 5;
        }
        else {
            this.ensureSpace(52);
            const avatarX = PAGE_MARGIN + 11;
            const avatarY = this.y + 3;
            this.page.drawCircle({ x: avatarX, y: avatarY, size: 11, color: message.isBot ? COLORS.blue : (0, pdf_lib_1.rgb)(0.36, 0.4, 0.48) });
            const initial = initialFor(message.authorName);
            const initialWidth = this.bold.widthOfTextAtSize(initial, 8);
            this.page.drawText(initial, {
                x: avatarX - initialWidth / 2,
                y: avatarY - 3,
                size: 8,
                font: this.bold,
                color: COLORS.white,
            });
            const availableAuthorWidth = CONTENT_WIDTH - MESSAGE_TEXT_INDENT - timeWidth - 18 - (message.isBot ? 34 : 0);
            const author = truncateToWidth(pdfSafe(message.authorName), this.bold, 10.5, Math.max(40, availableAuthorWidth));
            const authorX = PAGE_MARGIN + MESSAGE_TEXT_INDENT - 5;
            this.page.drawText(author, { x: authorX, y: this.y, size: 10.5, font: this.bold, color: COLORS.ink });
            if (message.isBot) {
                const authorWidth = this.bold.widthOfTextAtSize(author, 10.5);
                this.page.drawText('BOT', {
                    x: authorX + authorWidth + 6,
                    y: this.y + 1,
                    size: 6.2,
                    font: this.bold,
                    color: COLORS.blue,
                });
            }
            this.page.drawText(time, {
                x: PAGE_WIDTH - PAGE_MARGIN - timeWidth,
                y: this.y,
                size: 7.5,
                font: this.regular,
                color: COLORS.muted,
            });
            this.y -= 17;
        }
        if (message.content) {
            this.drawWrapped(message.content, {
                size: BODY_SIZE,
                lineHeight: BODY_LINE_HEIGHT,
                indent: MESSAGE_TEXT_INDENT,
            });
        }
        for (const embed of message.embeds)
            await this.drawEmbed(embed);
        for (const attachment of message.attachments)
            await this.drawAttachment(attachment);
        for (const sticker of message.stickers) {
            await this.drawImage(sticker.url, `Sticker: ${sticker.name}`, 180, sticker.url, MESSAGE_TEXT_INDENT);
        }
        if (!message.content && message.embeds.length === 0 && message.attachments.length === 0 && message.stickers.length === 0) {
            this.drawWrapped('No text message', {
                font: this.italic,
                size: 8.5,
                color: COLORS.muted,
                indent: MESSAGE_TEXT_INDENT,
                lineHeight: 12,
            });
        }
        this.y -= grouped ? 8 : 15;
    }
    drawParticipantIdentities(messages) {
        const participants = new Map();
        const addParticipant = (id, name) => {
            if (!id || id === 'unknown')
                return;
            const cleanName = cleanTag(name || 'unknown-user');
            const current = participants.get(id);
            if (!current) {
                participants.set(id, { names: [cleanName], lastName: cleanName });
                return;
            }
            if (cleanName !== 'unknown-user' && !current.names.includes(cleanName)) {
                current.names.push(cleanName);
                current.lastName = cleanName;
            }
        };
        addParticipant(this.meta.openedById, this.meta.openedByTag);
        for (const message of messages)
            addParticipant(message.authorId, message.authorName);
        addParticipant(this.meta.closedById, this.meta.closedByTag);
        this.ensureSpace(67);
        this.y -= 10;
        this.page.drawText('PARTICIPANT IDENTITIES', {
            x: PAGE_MARGIN,
            y: this.y,
            size: 7,
            font: this.bold,
            color: COLORS.muted,
        });
        this.y -= 13;
        this.page.drawText('Stable Discord user IDs remain valid if a user changes their username.', {
            x: PAGE_MARGIN,
            y: this.y,
            size: 7.5,
            font: this.regular,
            color: COLORS.muted,
        });
        this.y -= 16;
        this.page.drawText('NAME', {
            x: PAGE_MARGIN + 10,
            y: this.y,
            size: 6.2,
            font: this.bold,
            color: COLORS.muted,
        });
        this.page.drawText('USER ID', {
            x: PAGE_MARGIN + 255,
            y: this.y,
            size: 6.2,
            font: this.bold,
            color: COLORS.muted,
        });
        this.y -= 7;
        let rowIndex = 0;
        for (const [id, participant] of participants) {
            this.runtime.deadline.check('participant identity rendering');
            this.ensureSpace(25);
            if (rowIndex % 2 === 0) {
                this.page.drawRectangle({
                    x: PAGE_MARGIN,
                    y: this.y - 19,
                    width: CONTENT_WIDTH,
                    height: 23,
                    color: COLORS.panel,
                });
            }
            const nameHistory = participant.names.length > 1
                ? participant.names.join(' -> ')
                : participant.lastName;
            const displayName = truncateToWidth(pdfSafe(`@${nameHistory}`), this.regular, 8.5, 225);
            this.page.drawText(displayName, {
                x: PAGE_MARGIN + 10,
                y: this.y - 12,
                size: 8.5,
                font: this.regular,
                color: COLORS.body,
            });
            this.page.drawText(id, {
                x: PAGE_MARGIN + 255,
                y: this.y - 12,
                size: 8.5,
                font: this.regular,
                color: COLORS.blue,
            });
            const idWidth = this.regular.widthOfTextAtSize(id, 8.5);
            this.addLink(PAGE_MARGIN + 255, this.y - 14, idWidth, 12, `https://discord.com/users/${id}`);
            this.y -= 25;
            rowIndex += 1;
        }
        this.y -= 6;
    }
    async render(messages) {
        this.runtime.deadline.check('PDF rendering');
        this.drawHero();
        let previous = null;
        for (const message of messages) {
            this.runtime.deadline.check('message rendering');
            const grouped = previous !== null &&
                previous.authorId === message.authorId &&
                message.createdAt.getTime() - previous.createdAt.getTime() < GROUP_WINDOW_MS;
            await this.drawMessage(message, grouped);
            this.runtime.deadline.check('message rendering');
            previous = message;
        }
        this.runtime.deadline.check('participant identity rendering');
        this.drawParticipantIdentities(messages);
        this.runtime.deadline.check('participant identity rendering');
        const pageCount = this.doc.getPageCount();
        for (let index = 0; index < pageCount; index += 1) {
            this.runtime.deadline.check('PDF footer generation');
            const page = this.doc.getPage(index);
            page.drawLine({
                start: { x: PAGE_MARGIN, y: 39 },
                end: { x: PAGE_WIDTH - PAGE_MARGIN, y: 39 },
                thickness: 0.5,
                color: COLORS.line,
            });
            page.drawText('Bluxmart ticket transcript', {
                x: PAGE_MARGIN,
                y: 25,
                size: 7,
                font: this.regular,
                color: COLORS.muted,
            });
            const pageLabel = `Page ${index + 1} of ${pageCount}`;
            const pageLabelWidth = this.regular.widthOfTextAtSize(pageLabel, 7);
            page.drawText(pageLabel, {
                x: PAGE_WIDTH - PAGE_MARGIN - pageLabelWidth,
                y: 25,
                size: 7,
                font: this.regular,
                color: COLORS.muted,
            });
        }
        this.runtime.deadline.check('PDF serialization');
        const data = Buffer.from(await this.doc.save({ useObjectStreams: true }));
        this.runtime.deadline.check('PDF serialization');
        return data;
    }
}
async function renderPdf(messages, meta, includeImages, runtime) {
    const renderer = await PdfTranscriptRenderer.create(meta, includeImages, runtime);
    return renderer.render(messages);
}
function sanitizeOutputFilename(channelName) {
    const prefix = 'transcript-';
    const suffix = '.pdf';
    let value = String(channelName ?? '')
        .normalize('NFKC')
        .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*\p{Zl}\p{Zp}]/gu, '_')
        .replace(/\.{2,}/gu, '.')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/[. ]+$/u, '');
    value = Array.from(value).slice(0, 256).join('');
    if (value === '' || value === '.' || value === '..')
        value = 'ticket';
    // Stay below common filesystem/Discord filename limits even for 4-byte UTF-8.
    while (Buffer.byteLength(`${prefix}${value}${suffix}`, 'utf8') > 180 && value.length > 0) {
        value = Array.from(value).slice(0, -1).join('').replace(/[. ]+$/u, '');
    }
    return `${prefix}${value || 'ticket'}${suffix}`;
}
/**
 * Build exactly one PDF attachment. Images are fetched as binary JPEG/PNG data
 * and embedded in the PDF itself; there is no HTML or base64 payload. The
 * caller owns message-history retrieval and must pass a complete history; this
 * function never converts a fetch failure into a partial transcript.
 */
async function buildTranscriptFile(messages, maps, meta, options = {}) {
    const runtime = createTranscriptRuntime(options);
    try {
        if (!Array.isArray(messages))
            throw new TypeError('Transcript messages must be an array.');
        if (messages.length > runtime.limits.maxMessages) {
            throw new TranscriptLimitError('MESSAGE_LIMIT', `Transcript contains too many messages (${messages.length}; maximum ${runtime.limits.maxMessages}).`);
        }
        runtime.deadline.check('message normalization');
        const normalized = normalizeMessages(messages, maps, runtime.deadline);
        runtime.deadline.check('message normalization');
        const full = { ...meta, count: normalized.length };
        let data = await renderPdf(normalized, full, true, runtime);
        // A final hard guard: Discord must receive one upload, never a part sequence.
        const sizeLimit = Math.min(runtime.limits.maxPdfBytes, DISCORD_UPLOAD_BYTES);
        if (data.length >= sizeLimit) {
            data = await renderPdf(normalized, full, false, runtime);
        }
        if (data.length >= sizeLimit) {
            throw new TranscriptLimitError('PDF_SIZE_LIMIT', `Transcript PDF is too large (${data.length} bytes; maximum ${sizeLimit - 1}).`);
        }
        runtime.deadline.check('PDF completion');
        return {
            name: sanitizeOutputFilename(meta.channelName),
            data,
        };
    }
    finally {
        runtime.deadline.dispose();
    }
}
