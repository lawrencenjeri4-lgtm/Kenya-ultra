import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { spawn, spawnSync } from "child_process";

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

/**
 * Uploads a buffer to catbox.moe (no signup/API key needed) and
 * returns a direct, permanent URL to the file. Uses Node's built-in
 * fetch/FormData/Blob (Node 20+) — no extra dependency required.
 */
export async function uploadMediaAndGetUrl(buffer, mimetype) {

    const ext = EXT_FROM_MIME[mimetype] || "bin";

    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", new Blob([buffer], { type: mimetype }), `file.${ext}`);

    const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form
    });

    const text = (await res.text()).trim();

    if (!text.startsWith("http")) {
        throw new Error(text || "Upload failed.");
    }

    return text;

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

