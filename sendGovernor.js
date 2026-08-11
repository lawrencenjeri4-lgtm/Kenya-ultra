import chalk from "chalk";

// ============================================================
// Outbound send governor
// ============================================================
// Wraps sock.sendMessage ONCE so every existing call site in the
// codebase automatically benefits, without touching the dozens of
// places that already call it. This exists purely to keep the bot's
// outbound behavior inside patterns WhatsApp doesn't flag as
// spam/bot-like: bursts of messages, especially to numbers it's
// never talked to before, are the single biggest trigger for
// account restrictions.
//
// Deliberately conservative on duplicate suppression — blocking a
// message just because the same content was sent recently would
// break legitimate concurrent usage (two different people in a
// group both getting the same chatbot reply within a few seconds is
// normal, not spam). Only genuinely repeated bursts (3+ identical
// sends to the same chat in a few seconds — the signature of a
// retry-loop bug, not real usage) get suppressed.

const RATE_WINDOW_MS = 60 * 1000;
const BASE_RATE_LIMIT = 20; // sends/minute before throttling kicks in
const MIN_DELAY_MS = 700;
const MAX_ADAPTIVE_DELAY_MS = 8000;
const NEW_CHAT_EXTRA_DELAY_MS = 2500;
const DUPLICATE_BURST_WINDOW_MS = 5000;
const DUPLICATE_BURST_THRESHOLD = 3;

const knownChats = new Set();
const sendTimestamps = [];
const recentContentByChat = new Map(); // jid -> [{hash, timestamp}]
const queue = [];
let processing = false;

const stats = {
    totalSent: 0,
    suppressedBursts: 0,
    throttleEvents: 0,
    windowStart: Date.now()
};

function hashContent(content) {

    // Buffers (media) would make JSON.stringify explode in size and
    // aren't meaningfully comparable anyway — just note their length.
    const str = JSON.stringify(content, (key, value) => {
        if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
        return value;
    });

    let hash = 0;

    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }

    return hash;

}

function isReaction(content) {
    return Boolean(content?.react);
}

function currentSendRate() {

    const now = Date.now();

    while (sendTimestamps.length && now - sendTimestamps[0] > RATE_WINDOW_MS) {
        sendTimestamps.shift();
    }

    return sendTimestamps.length;

}

function isBurstDuplicate(jid, hash) {

    const now = Date.now();
    const history = recentContentByChat.get(jid) || [];

    const recent = history.filter(
        entry => entry.hash === hash && now - entry.timestamp < DUPLICATE_BURST_WINDOW_MS
    );

    recentContentByChat.set(
        jid,
        [...history.filter(e => now - e.timestamp < DUPLICATE_BURST_WINDOW_MS), { hash, timestamp: now }]
    );

    return recent.length >= DUPLICATE_BURST_THRESHOLD;

}

function computeDelay(jid) {

    let delay = MIN_DELAY_MS;

    const rate = currentSendRate();

    if (rate > BASE_RATE_LIMIT) {

        const overBy = rate - BASE_RATE_LIMIT;
        delay += Math.min(overBy * 400, MAX_ADAPTIVE_DELAY_MS);
        stats.throttleEvents++;

    }

    const isDirectMessage = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");

    if (isDirectMessage && !knownChats.has(jid)) {
        delay += NEW_CHAT_EXTRA_DELAY_MS;
    }

    return delay;

}

async function processQueue(originalSend) {

    if (processing) return;
    processing = true;

    while (queue.length) {

        const { jid, content, options, resolve, reject } = queue.shift();

        if (!isReaction(content)) {

            const hash = hashContent(content);

            if (isBurstDuplicate(jid, hash)) {

                stats.suppressedBursts++;

                console.log(
                    chalk.yellow(
                        `⚠ Suppressed a repeated-burst send to ${jid} (identical content sent ${DUPLICATE_BURST_THRESHOLD}+ times in ${DUPLICATE_BURST_WINDOW_MS / 1000}s — likely a retry loop, not real traffic)`
                    )
                );

                resolve(null);
                continue;

            }

        }

        const delay = computeDelay(jid);

        if (delay > MIN_DELAY_MS) {
            await new Promise(r => setTimeout(r, delay));
        }

        try {

            const result = await originalSend(jid, content, options);

            sendTimestamps.push(Date.now());
            stats.totalSent++;
            knownChats.add(jid);

            resolve(result);

        } catch (error) {

            reject(error);

        }

    }

    processing = false;

}

export function wrapSendMessage(sock) {

    const originalSend = sock.sendMessage.bind(sock);

    sock.sendMessage = (jid, content, options) => {

        return new Promise((resolve, reject) => {
            queue.push({ jid, content, options, resolve, reject });
            processQueue(originalSend);
        });

    };

    return sock;

}

export function getActivityStats() {

    return {
        ...stats,
        currentQueueDepth: queue.length,
        currentRatePerMinute: currentSendRate(),
        knownChats: knownChats.size
    };

}

// Periodic visibility into the console (matches how this deployment
// is actually monitored — Pterodactyl console — rather than adding a
// new round-trip to Core just for this).
export function startActivityLogging(intervalMs = 5 * 60 * 1000) {

    setInterval(() => {

        const snapshot = getActivityStats();

        console.log(
            chalk.cyan(
                `📊 Activity (last ${Math.round((Date.now() - stats.windowStart) / 60000)}m): ` +
                `${snapshot.totalSent} sent, ${snapshot.suppressedBursts} bursts suppressed, ` +
                `${snapshot.throttleEvents} throttle events, ${snapshot.currentRatePerMinute}/min current rate, ` +
                `queue depth ${snapshot.currentQueueDepth}`
            )
        );

        if (snapshot.currentRatePerMinute > BASE_RATE_LIMIT * 2) {

            console.log(
                chalk.red(
                    `🚨 Send rate is unusually high (${snapshot.currentRatePerMinute}/min) — the bot is self-throttling, but this is worth checking (spam, a stuck loop, or a broadcast command).`
                )
            );

        }

    }, intervalMs);

}
