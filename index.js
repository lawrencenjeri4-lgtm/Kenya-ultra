import dotenv from "dotenv";
import chalk from "chalk";
import http from "http";

import { proto } from "baileys";

import {
    createSocket,
    shouldReconnect,
    joinCommunity,
    downloadQuotedMedia,
    downloadMessageMedia
} from "./baileys.js";
import { bootstrapAuthState } from "./sessionBootstrap.js";
import core from "./core.js";
import { executeClientAction } from "./clientActions.js";
import { createSticker, retagSticker } from "./stickerUtils.js";

dotenv.config();

const VERSION = "1.0.0";

const SESSION_ID = process.env.SESSION_ID;

if (!SESSION_ID) {
    console.log(
        chalk.red("❌ SESSION_ID missing from .env")
    );
    process.exit(1);
}

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
        status: "online",
        service: "Kenya-Ultra Client",
        version: VERSION
    }));

}).listen(PORT, () => {

    console.log(
        chalk.blue(
            `🌐 Health check server listening on port ${PORT}`
        )
    );

});

console.clear();

console.log(chalk.green(`
██╗  ██╗███████╗███╗   ██╗██╗   ██╗ █████╗
██║ ██╔╝██╔════╝████╗  ██║╚██╗ ██╔╝██╔══██╗
█████╔╝ █████╗  ██╔██╗ ██║ ╚████╔╝ ███████║
██╔═██╗ ██╔══╝  ██║╚██╗██║  ╚██╔╝  ██╔══██║
██║  ██╗███████╗██║ ╚████║   ██║   ██║  ██║
╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝
`));

console.log(
    chalk.green(`Kenya-Ultra Public Bot v${VERSION}\n`)
);

let retryDelay = 3000;
const MAX_RETRY_DELAY = 60000;

let hasAttemptedAutoJoin = false;

let PREFIX = ".";

// Tracks message keys the bot has sent per chat during this runtime,
// so .delall can clean them up. Capped per chat to avoid unbounded growth.
const recentBotMessages = new Map();

// ================================
// Anti-Delete / Anti-Edit support
// ================================
//
// WhatsApp never actually deletes a message from a bot's point of
// view — "delete for everyone" and "edit" both arrive as a normal
// incoming message wrapping a protocolMessage that references the
// ORIGINAL message's key. So the only way to show "here's what was
// deleted/edited" is to keep our own short-lived cache of recent
// message content and look it up when one of those protocol
// messages comes in.

const recentMessages = new Map();
const MESSAGE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

setInterval(() => {

    const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS;

    for (const [id, entry] of recentMessages) {
        if (entry.timestamp < cutoff) {
            recentMessages.delete(id);
        }
    }

}, 10 * 60 * 1000);

// Group settings change rarely, so a short cache keeps us from
// hitting Core on every single incoming message while still picking
// up toggles within half a minute.
const groupSettingsCache = new Map();
const GROUP_SETTINGS_CACHE_MS = 30 * 1000;

async function getCachedGroupSettings(groupId) {

    const cached = groupSettingsCache.get(groupId);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.settings;
    }

    const settings = await core.getGroupSettings(groupId);

    groupSettingsCache.set(groupId, {
        settings,
        expiresAt: Date.now() + GROUP_SETTINGS_CACHE_MS
    });

    return settings;

}

async function cacheMessage(msg, jid, sender, text, needsMediaCache) {

    const id = msg.key.id;

    if (!id) return;

    const entry = {
        jid,
        sender,
        text,
        mediaType: null,
        mediaBuffer: null,
        timestamp: Date.now()
    };

    if (needsMediaCache) {

        try {

            const media = await downloadMessageMedia(msg.message);

            if (media) {
                entry.mediaType = media.type;
                entry.mediaBuffer = media.buffer;
            }

        } catch {}

    }

    recentMessages.set(id, entry);

}

async function handleRevoke(sock, jid, msg) {

    if (!jid.endsWith("@g.us")) return;

    const revokedKey = msg.message.protocolMessage.key;
    const deletedBy = msg.key.participant || msg.key.remoteJid;

    if (revokedKey.fromMe) return;

    const settings = await getCachedGroupSettings(jid);

    if (!settings.antidelete?.enabled) return;

    const cached = recentMessages.get(revokedKey.id);

    if (!cached) return;

    const mentions = [deletedBy, cached.sender].filter(Boolean);

    const header =
`🗑️ *Anti-Delete*

👤 Deleted by: @${deletedBy.split("@")[0]}
✍️ Originally sent by: @${cached.sender.split("@")[0]}`;

    try {

        if (cached.mediaBuffer) {

            const captioned =
                ["image", "video", "gif", "document"].includes(
                    cached.mediaType
                );

            const payload = {};

            if (cached.mediaType === "image") {
                payload.image = cached.mediaBuffer;
            } else if (
                cached.mediaType === "video" ||
                cached.mediaType === "gif"
            ) {
                payload.video = cached.mediaBuffer;
            } else if (cached.mediaType === "sticker") {
                payload.sticker = cached.mediaBuffer;
            } else if (
                cached.mediaType === "audio" ||
                cached.mediaType === "ptt"
            ) {
                payload.audio = cached.mediaBuffer;
                payload.ptt = cached.mediaType === "ptt";
                payload.mimetype = "audio/ogg; codecs=opus";
            } else if (cached.mediaType === "document") {
                payload.document = cached.mediaBuffer;
                payload.mimetype = "application/octet-stream";
            }

            if (captioned) {
                payload.caption = `${header}${cached.text ? `\n\n${cached.text}` : ""}`;
                payload.mentions = mentions;
            }

            await sock.sendMessage(jid, payload);

            if (!captioned) {
                await sock.sendMessage(jid, {
                    text: header,
                    mentions
                });
            }

        } else if (cached.text) {

            await sock.sendMessage(jid, {
                text: `${header}\n\n💬 "${cached.text}"`,
                mentions
            });

        } else {

            await sock.sendMessage(jid, {
                text: `${header}\n\n(content unavailable)`,
                mentions
            });

        }

    } catch (error) {

        console.log(
            chalk.red("❌ Anti-delete resend failed:", error.message)
        );

    }

    recentMessages.delete(revokedKey.id);

}

async function handleEdit(sock, jid, msg) {

    if (!jid.endsWith("@g.us")) return;

    const settings = await getCachedGroupSettings(jid);

    if (!settings.antiedit?.enabled) return;

    const protocolMessage = msg.message.protocolMessage;
    const originalKey = protocolMessage.key;
    const editedContent = protocolMessage.editedMessage;

    const newText =
        editedContent?.conversation ||
        editedContent?.extendedTextMessage?.text ||
        "(non-text content)";

    const cached = recentMessages.get(originalKey.id);
    const editor = msg.key.participant || msg.key.remoteJid;

    try {

        await sock.sendMessage(jid, {
            text:
`✏️ *Anti-Edit*

👤 Edited by: @${editor.split("@")[0]}

*Before:*
${cached?.text || "(not cached)"}

*After:*
${newText}`,
            mentions: [editor]
        });

    } catch (error) {

        console.log(
            chalk.red("❌ Anti-edit notice failed:", error.message)
        );

    }

    if (cached) {
        cached.text = newText;
    }

}

function trackSentMessage(jid, sentMsg) {

    if (!sentMsg?.key) return;

    if (!recentBotMessages.has(jid)) {
        recentBotMessages.set(jid, []);
    }

    const list = recentBotMessages.get(jid);

    list.push(sentMsg.key);

    if (list.length > 50) {
        list.shift();
    }

}

async function start() {

    try {

        console.log(
    chalk.blue("🌍 Connecting to Kenya-Ultra Core...")
);

await core.bootstrap();

console.log("");

console.log(
    chalk.blue("🔐 Preparing session...")
);

const authState =
    await bootstrapAuthState(SESSION_ID);

console.log(
    chalk.green("✅ Session ready")
);

await connect(authState);

    } catch (error) {

        console.log(
            chalk.red(
                `❌ Startup failed: ${error.message}`
            )
        );

        process.exit(1);

    }

}

async function connect(authState) {

    console.log(
        chalk.blue("📡 Connecting to WhatsApp...")
    );

    const sock =
        await createSocket(authState.state);

    // ---- Welcome / Goodbye ----
    // group-participants.update fires for actual membership changes
    // (someone already joined/left) — this is well-supported by
    // Baileys, unlike join *requests* below.
    sock.ev.on(
        "group-participants.update",
        async ({ id, participants, action }) => {

            try {

                const settings = await getCachedGroupSettings(id);

                if (action === "add" && settings.welcome?.enabled) {

                    const metadata = await sock.groupMetadata(id);

                    for (const participant of participants) {

                        await sock.sendMessage(id, {
                            text:
`👋 *Welcome!*

@${participant.split("@")[0]}, welcome to *${metadata.subject}*! 🎉

🐺 Powered by Kenya-Ultra 👑`,
                            mentions: [participant]
                        });

                    }

                }

                if (action === "remove" && settings.goodbye?.enabled) {

                    for (const participant of participants) {

                        await sock.sendMessage(id, {
                            text: `👋 @${participant.split("@")[0]} has left the group. Goodbye!`,
                            mentions: [participant]
                        });

                    }

                }

            } catch (error) {

                console.log(
                    chalk.red(
                        "❌ Welcome/goodbye handler failed:",
                        error.message
                    )
                );

            }

        }
    );

    // ---- Auto-approve / Auto-reject join requests ----
    // Baileys has no push event for pending group join requests (only
    // group-participants.update for already-approved membership
    // changes), so the only way to automate this is by polling
    // groupRequestParticipantsList on an interval — not instant, but
    // it's the only mechanism the library actually exposes.
    //
    // groupFetchAllParticipating() is a heavy call (full metadata for
    // every group the account is in), so this deliberately runs
    // infrequently and backs off further on failure — polling it
    // every 60s was tripping WhatsApp's own rate limiting
    // ("rate-overlimit") on accounts in a lot of groups.
    const JOIN_REQUEST_POLL_MS = 5 * 60 * 1000; // 5 minutes
    const JOIN_REQUEST_MAX_BACKOFF_MS = 30 * 60 * 1000; // cap at 30 minutes

    let joinRequestBackoffMs = 0;

    async function pollJoinRequests() {

        try {

            const groups = await sock.groupFetchAllParticipating();

            for (const groupId of Object.keys(groups)) {

                const settings = await getCachedGroupSettings(groupId);

                const mode =
                    settings.autoapprove?.enabled ? "approve" :
                    settings.autoreject?.enabled ? "reject" :
                    null;

                if (!mode) continue;

                const pending =
                    await sock.groupRequestParticipantsList(groupId);

                if (!pending?.length) continue;

                const ids = pending.map(p => p.jid);

                await sock.groupRequestParticipantsUpdate(
                    groupId,
                    ids,
                    mode
                );

                console.log(
                    chalk.green(
                        `✓ Auto-${mode}d ${ids.length} join request(s) in ${groupId}`
                    )
                );

            }

            joinRequestBackoffMs = 0;

        } catch (error) {

            joinRequestBackoffMs = joinRequestBackoffMs
                ? Math.min(joinRequestBackoffMs * 2, JOIN_REQUEST_MAX_BACKOFF_MS)
                : JOIN_REQUEST_POLL_MS;

            console.log(
                chalk.red(
                    `❌ Join-request polling failed (backing off ${Math.round(
                        joinRequestBackoffMs / 1000
                    )}s):`,
                    error.message
                )
            );

        }

        setTimeout(
            pollJoinRequests,
            JOIN_REQUEST_POLL_MS + joinRequestBackoffMs
        );

    }

    setTimeout(pollJoinRequests, JOIN_REQUEST_POLL_MS);

    sock.ev.on(
        "creds.update",
        async () => {

            try {

                await authState.saveCreds();

            } catch (error) {

                console.log(
                    chalk.red(
                        `❌ Failed to save credentials: ${error.message}`
                    )
                );

            }

        }
    );

    sock.ev.on(
        "connection.update",
        async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === "open") {

                console.log(
                    chalk.green(
                        "🟢 WhatsApp Connected"
                    )
                );

                retryDelay = 3000;

                if (!hasAttemptedAutoJoin) {

                    hasAttemptedAutoJoin = true;

                    await joinCommunity(sock);

                }

                try {

                    const settings = await core.getSettings(SESSION_ID);

                    PREFIX = settings.prefix || ".";

                    console.log(
                        chalk.cyan(`✓ Prefix   : ${PREFIX}`)
                    );

                    console.log(
                        chalk.cyan(`✓ Mode     : ${settings.mode}`)
                    );

                } catch (err) {

                    console.log(
                        chalk.yellow(
                            "⚠ Failed to load saved prefix, using default '.'"
                        )
                    );

                }

                const heartbeat =
    await core.heartbeat();

if (heartbeat) {

    console.log(
        chalk.green("🟢 Core Online")
    );

    console.log(
        chalk.cyan(
            `✓ Commands : ${core.manifest?.commandCount || "Unknown"}`
        )
    );

    console.log(
        chalk.cyan(
            `✓ Protocol : v${core.manifest?.protocol || "?"}`
        )
    );

    console.log(
        chalk.cyan(
            `✓ Version : ${core.manifest?.version || VERSION}`
        )
    );

}

            }

            if (connection === "close") {

                const reconnect =
                    shouldReconnect(lastDisconnect);

                console.log(
                    chalk.yellow(
                        "⚠ Connection closed"
                    )
                );

                if (reconnect) {

                    console.log(
                        chalk.blue(
                            `🔄 Reconnecting in ${retryDelay / 1000}s...`
                        )
                    );

                    setTimeout(
                        () => connect(authState),
                        retryDelay
                    );

                    retryDelay = Math.min(
                        retryDelay * 2,
                        MAX_RETRY_DELAY
                    );

                } else {

                    console.log(
                        chalk.red(
                            "❌ Logged out"
                        )
                    );

                }

            }

        }
    );

        sock.ev.on(
        "messages.upsert",
        async ({ messages }) => {

            const msg = messages[0];

            if (!msg.message) return;

            const jid = msg.key.remoteJid;

            let sender =
                msg.key.participant || msg.key.remoteJid;

            // Baileys 7.x LID migration: the same person can show up as
            // either their phone-number JID (@s.whatsapp.net) or their
            // LID (@lid) depending on how WhatsApp routed this specific
            // message. `participantAlt`/`remoteJidAlt` gives the OTHER
            // form of the same identity when WhatsApp knows it.
            let senderAlt =
                msg.key.participantAlt ||
                msg.key.remoteJidAlt ||
                null;

            // Prefer the phone-number JID as the canonical `sender`
            // whenever we know it — almost every permission check
            // (OWNER_NUMBER, botIds) compares against a phone number,
            // and @lid is an opaque WhatsApp-internal id with no
            // relation to the actual number, so it can't be "converted"
            // — only swapped in when WhatsApp happens to supply the
            // pairing. Keep the @lid form as senderAlt either way, as
            // a fallback for the (rarer) case where only @lid is known.
            if (
                sender.endsWith("@lid") &&
                senderAlt?.endsWith("@s.whatsapp.net")
            ) {
                [sender, senderAlt] = [senderAlt, sender];
            }

            const senderIdentities = [sender, senderAlt].filter(Boolean);

            // "Delete for everyone" and "edit" both arrive as a normal
            // incoming message wrapping a protocolMessage, rather than
            // an actual deletion/mutation of anything on our end.
            // Intercept those here before they'd otherwise be dropped
            // by the text checks below (they have no real text).
            const protocolType = msg.message.protocolMessage?.type;

            if (protocolType === proto.Message.ProtocolMessage.Type.REVOKE) {

                await handleRevoke(sock, jid, msg).catch(err =>
                    console.log(
                        chalk.red("❌ Anti-delete handler failed:", err.message)
                    )
                );

                return;

            }

            if (
                protocolType ===
                proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            ) {

                await handleEdit(sock, jid, msg).catch(err =>
                    console.log(
                        chalk.red("❌ Anti-edit handler failed:", err.message)
                    )
                );

                return;

            }

            // Previously this only ever looked at plain text /
            // extendedTextMessage, so ANY media message — captioned
            // or not (photos, videos, stickers, voice notes, etc.)
            // — never even reached Core. That silently broke every
            // media-based anti-* feature (antiphoto, antivideo,
            // antisticker, antivoice, antifile, antigif...) since
            // Core never got a chance to see those messages at all.
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";

            const hasMedia = Boolean(
                msg.message.imageMessage ||
                msg.message.videoMessage ||
                msg.message.stickerMessage ||
                msg.message.audioMessage ||
                msg.message.documentMessage ||
                msg.message.locationMessage ||
                msg.message.liveLocationMessage ||
                msg.message.contactMessage ||
                msg.message.contactsArrayMessage ||
                msg.message.pollCreationMessage ||
                msg.message.pollCreationMessageV2 ||
                msg.message.pollCreationMessageV3
            );

            if (msg.key.fromMe && !text.startsWith(PREFIX)) {
                return;
            }

            if (!text && !hasMedia) return;

            // Cache this message's content in case it gets deleted or
            // edited later. Only bother downloading the actual media
            // bytes (the expensive part) for groups that have
            // antidelete/antiedit switched on.
            if (jid.endsWith("@g.us")) {

                try {

                    const groupSettings = await getCachedGroupSettings(jid);

                    const needsMediaCache =
                        hasMedia &&
                        (groupSettings.antidelete?.enabled ||
                            groupSettings.antiedit?.enabled);

                    await cacheMessage(msg, jid, sender, text, needsMediaCache);

                } catch (err) {

                    console.log(
                        chalk.red("❌ Message caching failed:", err.message)
                    );

                }

            }

            console.log(
                chalk.cyan(`📩 Message from ${jid}: "${text}"`)
            );

            try {

                let groupMetadata = null;
                let isAdmin = false;
                let isBotAdmin = false;

                const botIds = [
                    sock.user.id.split(":")[0] + "@s.whatsapp.net",
                    sock.user.lid.split(":")[0] + "@lid"
                ];

                const isGroup = jid.endsWith("@g.us");

                if (isGroup) {

                    groupMetadata = await sock.groupMetadata(jid);

isAdmin = groupMetadata.participants.some(
    p => senderIdentities.includes(p.id) && p.admin
);

isBotAdmin = groupMetadata.participants.some(
    p => botIds.includes(p.id) && p.admin
);

                }

               // ==============================
// Automatic Loading UI
// ==============================

let loadingMessage = null;

const commandName = text
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

const loadingCommands = [
    "ytmp3",
    "ytmp4",
    "play",
    "video",
    "tiktok",
    "facebook",
    "fb",
    "instagram",
    "ig",
    "spotify",
    "mediafire"
];

if (loadingCommands.includes(commandName)) {

    await sock.sendMessage(jid, {
        react: {
            text: "⏳",
            key: msg.key
        }
    });

    loadingMessage = await sock.sendMessage(jid, {
        text:
`╭━━━〔 ⚡ Kenya-Ultra 〕━━━⬣

⏳ Processing your request...

━━━━━━━━━━━━━━

🔍 Searching...
📥 Downloading...
📦 Preparing file...

Please wait...

━━━━━━━━━━━━━━`
    });

    trackSentMessage(jid, loadingMessage);

}

// Execute command

let ppUrl = null;

try {

    ppUrl = await sock.profilePictureUrl(sender, "image");

} catch {

    // No public profile picture, or privacy settings block it —
    // expected for a lot of users, just fall back to no avatar.
    ppUrl = null;

}

const response = await core.execute(
    SESSION_ID,
    {
        text,
        sender,
        senderAlt,
        chat: jid,
        pushName: msg.pushName || "",
        ppUrl,
        isGroup,
        isAdmin,
        isBotAdmin,
        groupMetadata,
        message: msg.message,
        botIds
    }
);

// Mark loading as complete — delete the card itself, not just react
// on the original message. Previously this only reacted, so the
// "Processing your request..." card was left behind permanently,
// most visibly when Core silently ignores the request (e.g. private
// mode blocking a non-owner) and no other reply ever arrives.

if (loadingMessage) {

    try {

        await sock.sendMessage(jid, {
            delete: loadingMessage.key
        });

    } catch {}

}

console.log(
    chalk.cyan("📤 Core response:")
);

console.dir(response, { depth: null });

if (!response) return;

// Request was silently blocked by Core (e.g. private mode and the
// sender isn't the owner). Nothing further to send — the loading
// card is already cleaned up above.
if (response.ignored) {
    return;
}

if (loadingMessage) {

    try {

        await sock.sendMessage(jid, {
            react: {
                text: "✅",
                key: msg.key
            }
        });

    } catch {}

}

                const replyData =
    response.reply?.reply ??
    response.reply ??
    null;

const replyText =
    typeof response === "string"
        ? response
        : replyData?.text ??
          response.text ??
          response.message ??
          null;

const replyMentions =
    replyData?.mentions || [];

                if (response.action === "kick") {

    try {

        const ids = response.targets || (response.target ? [response.target] : []);

        await sock.groupParticipantsUpdate(
            jid,
            ids,
            "remove"
        );

        console.log(
            chalk.green(
                `👢 Removed ${ids.length} participant(s)`
            )
        );

    } catch (error) {

        console.log(
            chalk.red(
                "❌ Failed to kick:",
                error.message
            )
        );

        await sock.sendMessage(
            jid,
            {
                text: "❌ Failed to remove that user."
            }
        );

        return;

    }

}
else if (response.action === "add") {

    try {

        await sock.groupParticipantsUpdate(
            jid,
            [response.target],
            "add"
        );

        console.log(
            chalk.green(
                `➕ Added ${response.target}`
            )
        );

    } catch (error) {

        console.log(
            chalk.red(
                "❌ Failed to add:",
                error.message
            )
        );

        await sock.sendMessage(
            jid,
            {
                text: "❌ Failed to add that user."
            }
        );

        return;

    }

}

else if (response.action === "promote") {

    try {

        const ids = response.targets || (response.target ? [response.target] : []);

        await sock.groupParticipantsUpdate(
            jid,
            ids,
            "promote"
        );

        console.log(
            chalk.green(
                `👑 Promoted ${ids.length} participant(s)`
            )
        );

        if (response.revertAfterMs) {

            setTimeout(async () => {

                try {

                    await sock.groupParticipantsUpdate(jid, ids, "demote");

                    console.log(
                        chalk.yellow(`⏱ Auto-reverted promotion for ${ids.length} participant(s)`)
                    );

                } catch (err) {

                    console.log(chalk.red("❌ Failed to auto-revert promotion:", err.message));

                }

            }, response.revertAfterMs);

        }

    } catch (error) {

        console.log(
            chalk.red(
                "❌ Failed to promote:",
                error.message
            )
        );

        await sock.sendMessage(
            jid,
            {
                text: "❌ Failed to promote that user."
            }
        );

        return;

    }

}

else if (response.action === "demote") {

    try {

        const ids = response.targets || (response.target ? [response.target] : []);

        await sock.groupParticipantsUpdate(
            jid,
            ids,
            "demote"
        );

        console.log(
            chalk.green(
                `⬇️ Demoted ${ids.length} participant(s)`
            )
        );

        if (response.revertAfterMs) {

            setTimeout(async () => {

                try {

                    await sock.groupParticipantsUpdate(jid, ids, "promote");

                    console.log(
                        chalk.yellow(`⏱ Auto-restored admin for ${ids.length} participant(s)`)
                    );

                } catch (err) {

                    console.log(chalk.red("❌ Failed to auto-restore admin:", err.message));

                }

            }, response.revertAfterMs);

        }

    } catch (error) {

        console.log(
            chalk.red(error.message)
        );

    }

}

else if (response.action === "group_setting") {

    try {

        await sock.groupSettingUpdate(
            jid,
            response.setting
        );

        console.log(
            chalk.green(
                `⚙️ Group setting updated: ${response.setting}`
            )
        );

        if (response.revertAfterMs) {

            const reverted =
                response.setting === "announcement"
                    ? "not_announcement"
                    : "announcement";

            setTimeout(async () => {

                try {

                    await sock.groupSettingUpdate(jid, reverted);

                    console.log(
                        chalk.yellow(`⏱ Auto-reverted group setting to: ${reverted}`)
                    );

                } catch (err) {

                    console.log(chalk.red("❌ Failed to auto-revert group setting:", err.message));

                }

            }, response.revertAfterMs);

        }

    } catch (error) {

        console.log(
            chalk.red(
                "❌ Failed to update group setting:",
                error.message
            )
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to update the group setting. Make sure the bot is an admin."
        });

        return;

    }

}

else if (response.action === "update_subject") {

    try {

        await sock.groupUpdateSubject(
            jid,
            response.subject
        );

        console.log(
            chalk.green(`✏️ Group name updated to: ${response.subject}`)
        );

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to update group name:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to update the group name. Make sure the bot is an admin."
        });

        return;

    }

}

else if (response.action === "update_description") {

    try {

        await sock.groupUpdateDescription(
            jid,
            response.description
        );

        console.log(
            chalk.green("📝 Group description updated")
        );

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to update group description:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to update the group description. Make sure the bot is an admin."
        });

        return;

    }

}

else if (response.action === "revoke_invite") {

    try {

        const newCode = await sock.groupRevokeInvite(jid);

        await sock.sendMessage(jid, {
            text:
`🔗 *Group Link Reset*

New link:
https://chat.whatsapp.com/${newCode}

━━━━━━━━━━━━━━

🐺 Powered by Kenya-Ultra 👑`
        });

        console.log(chalk.green("🔗 Group invite link reset"));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to reset invite link:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to reset the group link. Make sure the bot is an admin."
        });

    }

    return;

}

else if (response.action === "get_invite_link") {

    try {

        const code = await sock.groupInviteCode(jid);

        await sock.sendMessage(jid, {
            text:
`🔗 *Group Invite Link*

https://chat.whatsapp.com/${code}

━━━━━━━━━━━━━━

🐺 Powered by Kenya-Ultra 👑`
        });

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to fetch invite link:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to fetch the group link. Make sure the bot is an admin."
        });

    }

    return;

}

else if (response.action === "export_vcf") {

    try {

        const lines = response.participants.map((id, i) => {

            const number = id.split("@")[0];

            return `BEGIN:VCARD\nVERSION:3.0\nFN:Member ${i + 1}\nTEL;type=CELL:+${number}\nEND:VCARD`;

        });

        const vcf = lines.join("\n");

        await sock.sendMessage(jid, {
            document: Buffer.from(vcf, "utf-8"),
            mimetype: "text/vcard",
            fileName: "members.vcf"
        });

        console.log(chalk.green(`📇 Exported ${response.participants.length} contacts`));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to export contacts:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to export contacts."
        });

    }

    return;

}

else if (response.action === "create_group") {

    try {

        const participants = [response.sender].filter(Boolean);

        const group = await sock.groupCreate(
            response.subject,
            participants
        );

        await sock.sendMessage(response.sender || jid, {
            text:
`✅ *Group Created*

📛 Name: ${response.subject}
🔗 https://chat.whatsapp.com/${await sock.groupInviteCode(group.id)}

━━━━━━━━━━━━━━

🐺 Powered by Kenya-Ultra 👑`
        });

        console.log(chalk.green(`✅ Created group: ${response.subject}`));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to create group:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to create the group."
        });

    }

    return;

}

else if (response.action === "handle_join_requests") {

    try {

        const pending = await sock.groupRequestParticipantsList(jid);

        if (!pending?.length) {

            await sock.sendMessage(jid, {
                text: "ℹ️ There are no pending join requests."
            });

            return;

        }

        const ids = pending.map(p => p.jid);

        await sock.groupRequestParticipantsUpdate(
            jid,
            ids,
            response.mode
        );

        await sock.sendMessage(jid, {
            text:
                response.mode === "approve"
                    ? `✅ Approved ${ids.length} join request(s).`
                    : `❌ Rejected ${ids.length} join request(s).`
        });

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to handle join requests:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to handle join requests. Make sure the bot is an admin."
        });

    }

    return;

}

else if (response.action === "make_sticker") {

    try {

        // Media is either directly attached to this message (sent
        // with .sticker as the caption) or on the message being
        // replied to.
        const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        const sourceContent = quoted || msg.message;

        const media = await downloadMessageMedia(sourceContent);

        if (!media || !["image", "video", "gif"].includes(media.type)) {

            await sock.sendMessage(jid, {
                text: "❌ Reply to an image, video, or GIF with .sticker (or send it directly with .sticker as the caption)."
            });

            return;

        }

        const stickerBuffer = await createSticker(media.buffer, {
            packname: response.packname,
            author: response.author
        });

        await sock.sendMessage(jid, {
            sticker: stickerBuffer
        });

    } catch (error) {

        console.log(
            chalk.red("❌ Sticker creation failed:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to create that sticker. Video/GIF stickers work best under ~10 seconds."
        });

    }

    return;

}

else if (response.action === "take_sticker") {

    try {

        const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quoted?.stickerMessage) {

            await sock.sendMessage(jid, {
                text: "❌ Reply to a sticker with .take to save it."
            });

            return;

        }

        const media = await downloadMessageMedia(quoted);

        if (!media || media.type !== "sticker") {

            await sock.sendMessage(jid, {
                text: "❌ Couldn't read that sticker, try again."
            });

            return;

        }

        const retaggedBuffer = await retagSticker(media.buffer, {
            packname: response.packname,
            author: response.author
        });

        await sock.sendMessage(jid, {
            sticker: retaggedBuffer
        });

    } catch (error) {

        console.log(
            chalk.red("❌ Sticker retag failed:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to save that sticker."
        });

    }

    return;

}

else if (response.action === "send_media_batch") {

    try {

        const items = response.items || [];

        if (!items.length) {

            await sock.sendMessage(jid, {
                text: "❌ No media found to send."
            });

            return;

        }

        for (let i = 0; i < items.length; i++) {

            const item = items[i];
            const isLast = i === items.length - 1;

            try {

                if (item.type === "video") {

                    await sock.sendMessage(jid, {
                        video: { url: item.url },
                        caption: isLast ? response.caption : undefined
                    });

                } else {

                    await sock.sendMessage(jid, {
                        image: { url: item.url },
                        caption: isLast ? response.caption : undefined
                    });

                }

            } catch (itemError) {

                console.log(
                    chalk.red(
                        `❌ Failed to send media batch item ${i + 1}:`,
                        itemError.message
                    )
                );

            }

        }

        if (response.reactEmoji) {

            try {

                await sock.sendMessage(jid, {
                    react: {
                        text: response.reactEmoji,
                        key: msg.key
                    }
                });

            } catch {}

        }

    } catch (error) {

        console.log(
            chalk.red("❌ Media batch send failed:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to send that media."
        });

    }

    return;

}

else if (response.action === "set_group_photo") {

    try {

        const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        const media = quoted ? await downloadQuotedMedia(quoted) : null;

        if (!media || media.type !== "image") {

            await sock.sendMessage(jid, {
                text: "❌ Reply to an image with .setppgc to use it as the group photo."
            });

            return;

        }

        await sock.updateProfilePicture(jid, media.buffer);

        await sock.sendMessage(jid, {
            text: "✅ Group photo updated."
        });

        console.log(chalk.green("🖼️ Group photo updated"));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to update group photo:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to update the group photo. Make sure the bot is an admin."
        });

    }

    return;

}

else if (response.action === "remove_group_photo") {

    try {

        await sock.removeProfilePicture(jid);

        await sock.sendMessage(jid, {
            text: "✅ Group photo removed."
        });

        console.log(chalk.green("🗑️ Group photo removed"));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to remove group photo:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to remove the group photo. Make sure the bot is an admin."
        });

    }

    return;

}

else if (response.action === "send_poll") {

    try {

        await sock.sendMessage(jid, {
            poll: {
                name: response.question,
                values: response.options,
                selectableCount: response.selectableCount || 1
            }
        });

        console.log(chalk.green(`📊 Poll sent: ${response.question}`));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to send poll:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to create the poll."
        });

    }

    return;

}

else if (response.action === "delete_own_messages") {

    try {

        const keys = recentBotMessages.get(jid) || [];

        for (const key of keys) {

            try {
                await sock.sendMessage(jid, { delete: key });
            } catch {}

        }

        recentBotMessages.delete(jid);

        console.log(chalk.yellow(`🧹 Cleared ${keys.length} bot message(s) in ${jid}`));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to clear bot messages:", error.message)
        );

    }

    return;

}

else if (response.action === "leave_group") {

    try {

        await sock.sendMessage(jid, {
            text: "👋 Leaving this group. Goodbye!"
        });

        await sock.groupLeave(jid);

        console.log(chalk.yellow(`👋 Left group: ${jid}`));

    } catch (error) {

        console.log(
            chalk.red("❌ Failed to leave group:", error.message)
        );

    }

    return;

}

else if (response.action === "get_profile_picture") {

    try {

        const ppUrl = await sock.profilePictureUrl(
            response.target,
            "image"
        );

        const isGroupTarget = response.target.endsWith("@g.us");

        let caption;
        let mentions = [];

        if (isGroupTarget) {

            const metadata = await sock.groupMetadata(response.target);
            caption = `🖼️ Profile picture of *${metadata.subject}*`;

        } else {

            caption = `🖼️ Profile picture of @${response.target.split("@")[0]}`;
            mentions = [response.target];

        }

        await sock.sendMessage(jid, {
            image: { url: ppUrl },
            caption,
            mentions
        });

    } catch (error) {

        await sock.sendMessage(jid, {
            text: "❌ Couldn't get that profile picture — it may not have one, or privacy settings block it."
        });

    }

    return;

}

else if (response.action === "set_bot_photo") {

    try {

        const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        const sourceContent = quoted || msg.message;

        const media = await downloadMessageMedia(sourceContent);

        if (!media || media.type !== "image") {

            await sock.sendMessage(jid, {
                text: "❌ Reply to an image with .setbotpp."
            });

            return;

        }

        await sock.updateProfilePicture(sock.user.id, media.buffer);

        await sock.sendMessage(jid, {
            text: "✅ Bot profile picture updated!"
        });

    } catch (error) {

        console.log(
            chalk.red("❌ setbotpp failed:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to update the bot's profile picture. Make sure the image is a valid format (jpg/png) and try again."
        });

    }

    return;

}

else if (response.action === "list_online") {

    try {

        const participants = response.participants || [];

        if (!participants.length) {

            await sock.sendMessage(jid, {
                text: "❌ No group members to check."
            });

            return;

        }

        await sock.sendMessage(jid, {
            text: "⏳ Checking who's online... this takes a few seconds."
        });

        const online = new Set();

        const handler = (updates) => {

            for (const update of updates) {

                if (!update.presences) continue;

                for (const [participantJid, presence] of Object.entries(update.presences)) {

                    if (
                        presence?.lastKnownPresence &&
                        presence.lastKnownPresence !== "unavailable"
                    ) {

                        online.add(participantJid);

                    }

                }

            }

        };

        sock.ev.on("presence.update", handler);

        try {
            await sock.presenceSubscribe(jid);
        } catch {}

        await new Promise(r => setTimeout(r, 8000));

        sock.ev.off("presence.update", handler);

        if (!online.size) {

            await sock.sendMessage(jid, {
                text:
"😴 Couldn't detect anyone online right now.\n\nNote: this only picks up members whose privacy settings allow their online status to be seen — it won't be 100% complete."
            });

            return;

        }

        const onlineList = [...online];

        const listText = onlineList
            .map((p, i) => `${i + 1}. @${p.split("@")[0]}`)
            .join("\n");

        await sock.sendMessage(jid, {
            text: `🟢 *Online Now (${onlineList.length})*\n\n${listText}`,
            mentions: onlineList
        });

    } catch (error) {

        console.log(
            chalk.red("❌ list_online failed:", error.message)
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to check who's online."
        });

    }

    return;

}

else if (response.action === "ping_probe") {

    try {

        await sock.sendMessage(jid, {
            react: { text: "🚀", key: msg.key }
        });

        const start = Date.now();

        const { key } = await sock.sendMessage(jid, { text: "wait.." });

        const done = Date.now() - start;

        const pong =
            `*Pong*:\n> ⏱️ ${done}ms (${Math.round(done / 100) / 10}s)`;

        await new Promise(resolve => setTimeout(resolve, 1000));

        await sock.sendMessage(jid, { text: pong, edit: key });

    } catch (error) {

        console.log(
            chalk.red("❌ Ping probe failed:", error.message)
        );

    }

    return;

}

else if (response.action === "moderate") {

    try {

        if (response.deleteTrigger) {

            try {

                await sock.sendMessage(jid, {
                    delete: msg.key
                });

            } catch (err) {

                console.log(
                    chalk.red(
                        "❌ Failed to delete violating message:",
                        err.message
                    )
                );

            }

        }

        if (response.reply?.text) {

            await sock.sendMessage(jid, {
                text: response.reply.text,
                mentions: response.reply.mentions || []
            });

        }

        if (response.kickTarget) {

            try {

                await sock.groupParticipantsUpdate(
                    jid,
                    [response.kickTarget],
                    "remove"
                );

            } catch (err) {

                console.log(
                    chalk.red(
                        "❌ Failed to remove user during moderation:",
                        err.message
                    )
                );

            }

        }

    } catch (error) {

        console.log(
            chalk.red("❌ Moderation action failed:", error.message)
        );

    }

    return;

}

else if (response.action === "delete_message") {

    try {

        await sock.sendMessage(jid, {
            delete: msg.key
        });

        console.log(
            chalk.yellow(
                `🔇 Deleted message from muted user ${sender}`
            )
        );

    } catch (error) {

        console.log(
            chalk.red(
                "❌ Failed to delete muted user's message:",
                error.message
            )
        );

    }

    return;

}

else if (response.action === "update_prefix") {

    if (response.prefix) {

        PREFIX = response.prefix;

        console.log(
            chalk.green(
                `🔧 Prefix updated to: ${PREFIX}`
            )
        );

    }

}

                else if (response.action === "recover_view_once") {

    try {

        const quoted =
            msg.message
                ?.extendedTextMessage
                ?.contextInfo
                ?.quotedMessage;

        if (!quoted) {

            await sock.sendMessage(jid, {
                text: "❌ No quoted message found."
            });

            return;

        }

        const media =
            await downloadQuotedMedia(quoted);

        if (!media) {

            await sock.sendMessage(jid, {
                text: "❌ Failed to download media."
            });

            return;

        }

        if (media.type === "image") {

            await sock.sendMessage(sender, {

                image: media.buffer,

                caption:
`╭⊷ 👁️ *VIEW ONCE RECOVERED*
│
├⊷ 🖼️ *Type:* Image
├⊷ 📥 *Status:* Delivered
│
╰⊷ 🐺 *Powered by Kenya-Ultra 👑*`

            });

        }

        else {

            await sock.sendMessage(sender, {

                video: media.buffer,

                caption:
`╭⊷ 👁️ *VIEW ONCE RECOVERED*
│
├⊷ 🎥 *Type:* Video
├⊷ 📥 *Status:* Delivered
│
╰⊷ 🐺 *Powered by Kenya-Ultra 👑*`

            });

        }

        console.log("✅ View Once recovered.");

    }

    catch (err) {

        console.log(err);

        await sock.sendMessage(jid, {

            text:
                "❌ Failed to recover View Once."

        });

    }

                }

                if (response.reply || response.action) {

    const handled = await executeClientAction({
        action: response.action,
        reply: response.reply,
        deleteTrigger: response.deleteTrigger,
        kickTarget: response.kickTarget,
        mediaType: response.mediaType,
        sock,
        jid,
        msg,
        sender
    });

    if (response.levelUp) {

        try {

            await executeClientAction({
                action: null,
                reply: response.levelUp,
                sock,
                jid,
                msg,
                sender
            });

        } catch (err) {

            console.log(
                chalk.red("LEVEL UP CARD ERROR:", err.message)
            );

        }

    }

    if (handled) {
        return;
    }

}

if (replyText) {

    const sent = await sock.sendMessage(jid, {
        text: replyText,
        mentions: replyMentions
    });

    trackSentMessage(jid, sent);

    if (response.levelUp) {

        try {

            await executeClientAction({
                action: null,
                reply: response.levelUp,
                sock,
                jid,
                msg,
                sender
            });

        } catch (err) {

            console.log(
                chalk.red("LEVEL UP CARD ERROR:", err.message)
            );

        }

    }

}

            } catch (error) {

                console.log(
                    chalk.red(
                        "COMMAND ERROR:",
                        error.message
                    )
                );

                try {

                    await sock.sendMessage(jid, {
                        react: {
                            text: "❌",
                            key: msg.key
                        }
                    });

                } catch {}

            }

        }
    );

}

start();
