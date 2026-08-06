import dotenv from "dotenv";
import chalk from "chalk";
import http from "http";

import {
    createSocket,
    shouldReconnect,
    joinCommunity,
    downloadQuotedMedia
} from "./baileys.js";
import { bootstrapAuthState } from "./sessionBootstrap.js";
import core from "./core.js";
import { executeClientAction, selfUpdateAndRestart } from "./clientActions.js";

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

            const sender =
                msg.key.participant || msg.key.remoteJid;

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            if (msg.key.fromMe && !text.startsWith(PREFIX)) {
                return;
            }

            if (!text) return;

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
    p => p.id === sender && p.admin
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

}

// Execute command

const response = await core.execute(
    SESSION_ID,
    {
        text,
        sender,
        chat: jid,
        pushName: msg.pushName || "",
        isGroup,
        isAdmin,
        isBotAdmin,
        groupMetadata,
        message: msg.message,
        botIds
    }
);

// Mark loading as complete

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

                console.log(
    chalk.cyan("📤 Core response:")
);

console.dir(response, { depth: null });

                if (!response) return;

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

                else if (response.action === "post_group_status") {

    try {

        const quoted =
            msg.message
                ?.extendedTextMessage
                ?.contextInfo
                ?.quotedMessage;

        if (!quoted) {

            await sock.sendMessage(jid, {
                text: "❌ No quoted photo found."
            });

            return;

        }

        const media =
            await downloadQuotedMedia(quoted);

        if (!media || media.type !== "image") {

            await sock.sendMessage(jid, {
                text: "❌ Failed to download the photo."
            });

            return;

        }

        const caption =
`╭⊷ 📢 *GROUP STATUS*
│
├⊷ ${response.captionText || "📸"}
│
├⊷ 👤 *Posted by:* ${response.postedBy || "Admin"}
├⊷ 🕒 *When:* ${response.timestamp || ""}
│
╰⊷ 🐺 *Powered by Kenya-Ultra 👑*`;

        await sock.sendMessage(jid, {

            image: media.buffer,

            caption

        });

        console.log("✅ Group status (photo) posted.");

    }

    catch (err) {

        console.log(err);

        await sock.sendMessage(jid, {

            text:
                "❌ Failed to post status."

        });

    }

                }

                else if (response.action === "self_update") {

    try {

        await selfUpdateAndRestart({

            onProgress: async (text) => {

                try {
                    await sock.sendMessage(jid, { text });
                } catch (_) {}

            }

        });

        // Process exits inside selfUpdateAndRestart once the
        // respawned instance has been launched — nothing runs
        // after this point.

    }

    catch (err) {

        console.log(err);

        await sock.sendMessage(jid, {

            text:
                `❌ Update failed: ${err.message || "Unknown error"}`

        });

    }

                }

                if (response.reply) {

    const handled = await executeClientAction({
        action: response.action,
        reply: response.reply,
        sock,
        jid,
        msg,
        sender
    });

    if (handled) {
        return;
    }

}

if (replyText) {

    await sock.sendMessage(jid, {
        text: replyText,
        mentions: replyMentions
    });

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

            
