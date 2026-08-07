import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { spawn, spawnSync } from "child_process";

// ============================================================
// Auto-reply
// ============================================================

const AUTOREPLY_PATH = path.join(process.cwd(), "autoreply.json");
const AUTOREPLY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min per contact

function loadAutoReply() {

    if (!fs.existsSync(AUTOREPLY_PATH)) {

        return {
            enabled: false,
            dm: true,
            groupMention: true,
            message: "🤖 Auto-reply: I'm unavailable right now. I'll get back to you soon!",
            schedule: null,
            cooldowns: {}
        };

    }

    try {
        return JSON.parse(fs.readFileSync(AUTOREPLY_PATH, "utf8"));
    } catch (_) {
        return { enabled: false, dm: true, groupMention: true, message: "", schedule: null, cooldowns: {} };
    }

}

function saveAutoReply(cfg) {
    fs.writeFileSync(AUTOREPLY_PATH, JSON.stringify(cfg, null, 2));
}

// schedule format: "HH:MM-HH:MM", handles ranges that cross midnight
function isInAutoReplySchedule(cfg) {

    if (!cfg.schedule || !cfg.schedule.includes("-")) return true;

    const [start, end] = cfg.schedule.split("-");
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);

    if ([sh, sm, eh, em].some(Number.isNaN)) return true;

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;

    if (startMin > endMin) return nowMin >= startMin || nowMin <= endMin;
    return nowMin >= startMin && nowMin <= endMin;

}

/**
 * Call on every incoming (non-fromMe) message. Returns
 * { message, mentionedJid } to send, or null if auto-reply
 * shouldn't fire for this message.
 */
export function checkAutoReply(msg, botIds) {

    const cfg = loadAutoReply();

    if (!cfg.enabled || !isInAutoReplySchedule(cfg)) return null;
    if (msg.key.fromMe) return null;

    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || jid;
    const isGroup = jid.endsWith("@g.us");

    const isMentioned =
        isGroup &&
        (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])
            .some((id) => botIds.includes(id));

    const triggerDM = !isGroup && cfg.dm;
    const triggerGroup = isGroup && cfg.groupMention && isMentioned;

    if (!triggerDM && !triggerGroup) return null;

    const key = `${sender}-${jid}`;
    const last = cfg.cooldowns[key] || 0;

    if (Date.now() - last < AUTOREPLY_COOLDOWN_MS) return null;

    cfg.cooldowns[key] = Date.now();
    saveAutoReply(cfg);

    return {
        message: cfg.message,
        mentionedJid: isGroup ? [sender] : []
    };

}

/**
 * Handles ".autoreply <subcommand>" locally (owner-only, checked by
 * the caller via msg.key.fromMe). Returns the reply text to send.
 */
export function handleAutoReplyCommand(args) {

    const cfg = loadAutoReply();
    const sub = (args[0] || "").toLowerCase();

    switch (sub) {

        case "on":
            cfg.enabled = true;
            saveAutoReply(cfg);
            return "✅ Auto-reply turned *ON*.";

        case "off":
            cfg.enabled = false;
            saveAutoReply(cfg);
            return "✅ Auto-reply turned *OFF*.";

        case "dm":
            cfg.dm = (args[1] || "").toLowerCase() !== "off";
            saveAutoReply(cfg);
            return `✅ DM auto-reply: *${cfg.dm ? "ON" : "OFF"}*`;

        case "group":
            cfg.groupMention = (args[1] || "").toLowerCase() !== "off";
            saveAutoReply(cfg);
            return `✅ Group-mention auto-reply: *${cfg.groupMention ? "ON" : "OFF"}*`;

        case "setmsg": {

            const text = args.slice(1).join(" ").trim();

            if (!text) return "❌ Provide a message.\nExample:\n.autoreply setmsg I'm away, back soon!";

            cfg.message = text;
            saveAutoReply(cfg);
            return "✅ Auto-reply message updated.";

        }

        case "schedule": {

            const value = args[1];

            if (!value || value.toLowerCase() === "off") {
                cfg.schedule = null;
                saveAutoReply(cfg);
                return "✅ Schedule cleared — auto-reply active any time it's ON.";
            }

            if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(value)) {
                return "❌ Use the format HH:MM-HH:MM\nExample:\n.autoreply schedule 22:00-06:00";
            }

            cfg.schedule = value;
            saveAutoReply(cfg);
            return `✅ Schedule set: *${value}*`;

        }

        case "resetcooldowns":
            cfg.cooldowns = {};
            saveAutoReply(cfg);
            return "✅ Cooldowns cleared.";

        case "status":
        case undefined:
        case "":
            return (
`╭⊷ 🤖 *AUTO-REPLY*

│

├⊷ Status: *${cfg.enabled ? "ON ✅" : "OFF ❌"}*
├⊷ DM: *${cfg.dm ? "ON" : "OFF"}*
├⊷ Group mentions: *${cfg.groupMention ? "ON" : "OFF"}*
├⊷ Schedule: *${cfg.schedule || "Always"}*
├⊷ Message: ${cfg.message}

│

├⊷ *.autoreply on/off*
├⊷ *.autoreply dm on/off*
├⊷ *.autoreply group on/off*
├⊷ *.autoreply setmsg <text>*
├⊷ *.autoreply schedule HH:MM-HH:MM* (or off)
├⊷ *.autoreply resetcooldowns*

│

╰⊷ 🐺 *Kenya-Ultra*`
            );

        default:
            return "❌ Unknown subcommand. Use *.autoreply status* to see options.";

    }

}

const UPDATE_REPO = process.env.UPDATE_REPO || "lawrencenjeri4-lgtm/Kenya-Ultra";
const UPDATE_BRANCH = process.env.UPDATE_BRANCH || "main";

// Never overwrite/delete these when copying the fresh code over
const UPDATE_EXCLUDE = new Set([
    "node_modules",
    ".git",
    ".env",
    "auth_info"
]);

function copyRecursive(src, dest) {

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {

        if (UPDATE_EXCLUDE.has(entry.name)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {

            fs.mkdirSync(destPath, { recursive: true });
            copyRecursive(srcPath, destPath);

        } else {

            fs.copyFileSync(srcPath, destPath);

        }

    }

}

/**
 * Downloads the latest code from GitHub, copies it over the current
 * working directory (preserving node_modules/.git/.env/auth_info),
 * runs npm install, then respawns the process and exits — restarting
 * this bot instance only. Uses the `tar` binary (present by default
 * on Alpine/most Linux base images) instead of an npm dependency.
 */
export async function selfUpdateAndRestart({ onProgress } = {}) {

    const tarballUrl = `https://github.com/${UPDATE_REPO}/archive/refs/heads/${UPDATE_BRANCH}.tar.gz`;

    onProgress?.("📥 Downloading latest code...");

    const { data } = await axios.get(tarballUrl, {
        responseType: "arraybuffer"
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ku-update-"));
    const tarPath = path.join(tmpDir, "update.tar.gz");

    fs.writeFileSync(tarPath, data);

    onProgress?.("📦 Extracting update...");

    const extract = spawnSync("tar", ["-xzf", tarPath, "-C", tmpDir]);

    if (extract.status !== 0) {
        throw new Error("Failed to extract update archive (is `tar` available?).");
    }

    // GitHub tarballs extract into a single "<repo>-<branch>" folder
    const extractedFolder = fs
        .readdirSync(tmpDir, { withFileTypes: true })
        .find((e) => e.isDirectory());

    if (!extractedFolder) {
        throw new Error("Could not find extracted update folder.");
    }

    const extractedPath = path.join(tmpDir, extractedFolder.name);

    onProgress?.("🛠️ Applying update...");

    copyRecursive(extractedPath, process.cwd());

    fs.rmSync(tmpDir, { recursive: true, force: true });

    onProgress?.("📦 Installing dependencies...");

    const install = spawnSync("npm", ["install", "--omit=dev"], {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true
    });

    if (install.status !== 0) {
        throw new Error("npm install failed after update.");
    }

    onProgress?.("♻️ Restarting...");

    // Respawn this process — works the same on Docker/Railway/Render/
    // Pterodactyl, since it doesn't depend on the host's crash-restart policy
    const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        stdio: "inherit"
    });

    child.unref();

    setTimeout(() => process.exit(0), 500);

}

const EXT_FROM_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp"
};

async function uploadToCatbox(buffer, mimetype, ext) {

    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", new Blob([buffer], { type: mimetype }), `file.${ext}`);

    const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        headers: {
            // catbox's anti-abuse filter blocks requests that don't
            // look browser-like — this alone fixes it in many cases
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: form
    });

    const text = (await res.text()).trim();

    if (!text.startsWith("http")) {
        throw new Error(text || "catbox upload failed");
    }

    return text;

}

async function uploadTo0x0(buffer, mimetype, ext) {

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `file.${ext}`);

    const res = await fetch("https://0x0.st", {
        method: "POST",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: form
    });

    const text = (await res.text()).trim();

    if (!text.startsWith("http")) {
        throw new Error(text || "0x0.st upload failed");
    }

    return text;

}

async function uploadToTmpfiles(buffer, mimetype, ext) {

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `file.${ext}`);

    const res = await fetch("https://tmpfiles.org/api/v1/upload", {
        method: "POST",
        body: form
    });

    const json = await res.json();

    if (!json?.data?.url) {
        throw new Error("tmpfiles upload failed");
    }

    // tmpfiles' page URL needs "/dl/" inserted to become a direct link
    return json.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");

}

/**
 * Uploads a buffer and returns a direct URL, no signup/API key needed.
 * Tries hosts in order of how long the link lasts:
 *   1. catbox.moe   — permanent, but blocks a lot of datacenter/VPS
 *      IPs (common on hosting panels like Pterodactyl) with a
 *      generic "Invalid uploader" error.
 *   2. 0x0.st        — retention scales with file size/popularity
 *      (minimum ~30 days), rarely blocks server IPs.
 *   3. tmpfiles.org  — always accepts server uploads, but links
 *      expire in 1 hour. Last-resort only.
 */
export async function uploadMediaAndGetUrl(buffer, mimetype) {

    const ext = EXT_FROM_MIME[mimetype] || "bin";

    try {

        return await uploadToCatbox(buffer, mimetype, ext);

    } catch (err) {

        console.log(
            chalk.yellow(`Catbox upload failed (${err.message}), trying 0x0.st...`)
        );

    }

    try {

        return await uploadTo0x0(buffer, mimetype, ext);

    } catch (err) {

        console.log(
            chalk.yellow(`0x0.st upload failed (${err.message}), falling back to tmpfiles...`)
        );

        return await uploadToTmpfiles(buffer, mimetype, ext);

    }

}

export async function executeClientAction({
    action,
    reply,
    sock,
    jid,
    msg,
    sender
}) {

    // ==========================
    // Reply Types
    // ==========================

    if (reply?.type) {

        switch (reply.type) {

            case "text":

                await sock.sendMessage(jid, {
                    text: reply.text,
                    mentions: reply.mentions || []
                });

                return true;

            case "audio":

                await sock.sendMessage(jid, {
                    audio: { url: reply.url },
                    mimetype: reply.mimetype,
                    fileName: reply.fileName,
                    caption: reply.caption,
                    contextInfo: reply.contextInfo || undefined
                });

                if (reply.alsoDocument) {

                    await sock.sendMessage(jid, {
                        document: { url: reply.url },
                        mimetype: reply.mimetype,
                        fileName: reply.fileName
                    });

                }

                return true;

            case "video":

                await sock.sendMessage(jid, {
                    video: { url: reply.url },
                    mimetype: reply.mimetype,
                    fileName: reply.fileName,
                    caption: reply.caption,
                    contextInfo: reply.contextInfo || undefined
                });

                if (reply.alsoDocument) {

                    await sock.sendMessage(jid, {
                        document: { url: reply.url },
                        mimetype: reply.mimetype,
                        fileName: reply.fileName
                    });

                }

                return true;

            case "image": {

                try {

                    let image;

                    if (reply.file) {

                        const imagePath = path.join(
                            process.cwd(),
                            "assets",
                            "images",
                            reply.file
                        );

                        image = fs.readFileSync(imagePath);

                    } else {

                        image = {
                            url: reply.url
                        };

                    }

                    await sock.sendMessage(jid, {
                        image,
                        caption: reply.caption || ""
                    });

                    if (reply.contact) {

                        const phone = reply.contact.phone.replace(/\+/g, "");

                        const vcard =
`BEGIN:VCARD
VERSION:3.0
FN:${reply.contact.displayName}
TEL;type=CELL;type=VOICE;waid=${phone}:${reply.contact.phone}
END:VCARD`;

                        await sock.sendMessage(jid, {
                            contacts: {
                                displayName: reply.contact.displayName,
                                contacts: [{
                                    vcard
                                }]
                            }
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red("IMAGE ERROR:", err.message)
                    );

                    return false;

                }

            }

            case "group_icon": {

                try {

                    let iconUrl;

                    try {

                        iconUrl = await sock.profilePictureUrl(jid, "image");

                    } catch (err) {

                        iconUrl = null;

                    }

                    if (iconUrl) {

                        await sock.sendMessage(jid, {
                            image: { url: iconUrl },
                            caption: reply.caption || "",
                            mentions: reply.mentions || []
                        });

                    } else {

                        // Group has no icon set — fall back to plain text
                        await sock.sendMessage(jid, {
                            text: reply.caption || "",
                            mentions: reply.mentions || []
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red("GROUP ICON ERROR:", err.message)
                    );

                    return false;

                }

            }

            case "download": {

                try {

                    const isAudio = reply.mediaType === "audio";

                    const caption =
`${isAudio ? "🎵" : "🎬"} *${reply.title || "Download"}*

📡 ${reply.source || "Unknown source"} | ⏱ ${reply.duration || "Unknown"} | 💾 ${reply.size || "Unknown"}

━━━━━━━━━━━━━━

✅ Download Complete

🐺 Powered by Kenya-Ultra 👑`;

                    const contextInfo = reply.thumbnail ? {
                        externalAdReply: {
                            title: reply.title || "Kenya-Ultra",
                            body: `${reply.source || "Kenya-Ultra"} • ${reply.duration || ""}`,
                            thumbnailUrl: reply.thumbnail,
                            sourceUrl: reply.url,
                            mediaType: 1,
                            renderLargerThumbnail: true,
                            showAdAttribution: false
                        }
                    } : undefined;

                    if (isAudio) {

                        await sock.sendMessage(jid, {
                            audio: { url: reply.url },
                            mimetype: reply.mimetype || "audio/mpeg",
                            fileName: reply.fileName || "audio.mp3",
                            caption,
                            contextInfo
                        });

                    } else {

                        await sock.sendMessage(jid, {
                            video: { url: reply.url },
                            mimetype: reply.mimetype || "video/mp4",
                            fileName: reply.fileName || "video.mp4",
                            caption,
                            contextInfo
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red("DOWNLOAD ERROR:", err.message)
                    );

                    return false;

                }

            }

            case "document":

                await sock.sendMessage(jid, {
                    document: { url: reply.url },
                    fileName: reply.fileName,
                    mimetype: reply.mimetype
                });

                return true;

            case "sticker":

                await sock.sendMessage(jid, {
                    sticker: { url: reply.url }
                });

                return true;

            default:

                console.log(
                    chalk.yellow(`⚠ Unknown reply type: ${reply.type}`)
                );

                return false;

        }

    }

    // ==========================
    // Actions already handled in index.js
    // ==========================

    switch (action) {

        case "recover_view_once":
        case "delete_message":
            return true;

        default:
            return false;

    }

}

