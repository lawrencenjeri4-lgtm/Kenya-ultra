import chalk from "chalk";
import fs from "fs";
import path from "path";
import { downloadQuotedMedia, downloadMessageMedia } from "./baileys.js";

// ==========================
// Nano / Nanopro helpers
// ==========================

// Per-sender in-progress .nanopro image collections. Lives in memory
// on the gateway process — same pattern as the reference bot's
// bananaSession — since this process holds the live socket anyway
// and isn't restarted per-message.
const nanoProSessions = new Map();

async function uploadToCdn(buffer, filename = "image.jpg") {

    try {

        const form = new FormData();
        form.append("file", new Blob([buffer]), filename);
        form.append("type", "permanent");

        const res = await fetch("https://tmp.malvryx.dev/upload", {
            method: "POST",
            body: form
        });

        const data = await res.json();

        return data?.cdnUrl || data?.directUrl || null;

    } catch {

        return null;

    }

}

async function pollNanoResult(taskId, maxAttempts = 25, delayMs = 5000) {

    for (let i = 0; i < maxAttempts; i++) {

        await new Promise(resolve => setTimeout(resolve, delayMs));

        const res = await fetch(
            `https://omegatech-api.dixonomega.tech/api/ai/nano-banana2-result?task_id=${taskId}`
        );

        const data = await res.json();

        if (data.status === "completed" && data.image_url) {
            return data.image_url;
        }

        if (data.status === "failed") {
            throw new Error("Generation failed.");
        }

    }

    throw new Error("Timed out.");

}

export async function executeClientAction({
    action,
    reply,
    deleteTrigger,
    kickTarget,
    sock,
    jid,
    msg,
    sender,
    groupMetadata,
    message,
    prompt,
    input
}) {

    // ==========================
    // Moderation
    // ==========================

    if (deleteTrigger) {

        try {

            await sock.sendMessage(jid, {
                delete: msg.key
            });

        } catch (error) {

            console.log(
                chalk.red(
                    "❌ Failed to delete moderated message:",
                    error.message
                )
            );

        }

    }

    if (kickTarget) {

        try {

            await sock.groupParticipantsUpdate(
                jid,
                [kickTarget],
                "remove"
            );

        } catch (error) {

            console.log(
                chalk.red(
                    "❌ Failed to kick moderated user:",
                    error.message
                )
            );

        }

    }

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
                    mentions: reply.mentions || [],
                    gifPlayback: reply.gifPlayback || undefined,
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

                    if (reply.file && reply.file.startsWith("data:")) {

                        const base64 = reply.file.split(",")[1];
                        image = Buffer.from(base64, "base64");

                    }

                    else if (reply.file) {

                        const imagePath = path.join(
                            process.cwd(),
                            "assets",
                            "images",
                            reply.file
                        );

                        image = fs.readFileSync(imagePath);

                    }

                    else {

                        image = {
                            url: reply.url
                        };

                    }

                    await sock.sendMessage(jid, {
                        image,
                        caption: reply.caption || "",
                        mentions: reply.mentions || []
                    });

                    if (reply.contact) {

                        const phone =
                            reply.contact.phone.replace(/\+/g, "");

                        const vcard =
`BEGIN:VCARD
VERSION:3.0
FN:${reply.contact.displayName}
TEL;type=CELL;type=VOICE;waid=${phone}:${reply.contact.phone}
END:VCARD`;

                        await sock.sendMessage(jid, {
                            contacts: {
                                displayName:
                                    reply.contact.displayName,
                                contacts: [{
                                    vcard
                                }]
                            }
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red(
                            "IMAGE ERROR:",
                            err.message
                        )
                    );

                    return false;

                }

            }
                            case "group_icon": {

                try {

                    let iconUrl;

                    try {

                        iconUrl =
                            await sock.profilePictureUrl(
                                jid,
                                "image"
                            );

                    } catch {

                        iconUrl = null;

                    }

                    if (iconUrl) {

                        await sock.sendMessage(jid, {
                            image: { url: iconUrl },
                            caption: reply.caption || "",
                            mentions: reply.mentions || []
                        });

                    } else {

                        await sock.sendMessage(jid, {
                            text: reply.caption || "",
                            mentions: reply.mentions || []
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red(
                            "GROUP ICON ERROR:",
                            err.message
                        )
                    );

                    return false;

                }

            }

            case "download": {

                try {

                    const isAudio =
                        reply.mediaType === "audio";

                    const caption =
`${isAudio ? "🎵" : "🎬"} *${reply.title || "Download"}*

📡 ${reply.source || "Unknown"}
⏱ ${reply.duration || "Unknown"}
💾 ${reply.size || "Unknown"}

━━━━━━━━━━━━━━

✅ Download Complete

🐺 Powered by Kenya-Ultra 👑`;

                    const contextInfo =
                        reply.thumbnail
                            ? {
                                externalAdReply: {
                                    title:
                                        reply.title ||
                                        "Kenya-Ultra",
                                    body:
                                        `${reply.source || "Kenya-Ultra"} • ${reply.duration || ""}`,
                                    thumbnailUrl:
                                        reply.thumbnail,
                                    sourceUrl:
                                        reply.url,
                                    mediaType: 1,
                                    renderLargerThumbnail: true,
                                    showAdAttribution: false
                                }
                            }
                            : undefined;

                    if (isAudio) {

                        await sock.sendMessage(jid, {
                            audio: {
                                url: reply.url
                            },
                            mimetype:
                                reply.mimetype ||
                                "audio/mpeg",
                            fileName:
                                reply.fileName ||
                                "audio.mp3",
                            caption,
                            contextInfo
                        });

                    } else {

                        await sock.sendMessage(jid, {
                            video: {
                                url: reply.url
                            },
                            mimetype:
                                reply.mimetype ||
                                "video/mp4",
                            fileName:
                                reply.fileName ||
                                "video.mp4",
                            caption,
                            contextInfo
                        });

                    }

                    return true;

                } catch (err) {

                    console.log(
                        chalk.red(
                            "DOWNLOAD ERROR:",
                            err.message
                        )
                    );

                    return false;

                }

            }

            case "document":

                await sock.sendMessage(jid, {
                    document: {
                        url: reply.url
                    },
                    fileName: reply.fileName,
                    mimetype: reply.mimetype
                });

                return true;

            case "sticker":

                await sock.sendMessage(jid, {
                    sticker: {
                        url: reply.url
                    }
                });

                return true;

            default:

                console.log(
                    chalk.yellow(
                        `⚠ Unknown reply type: ${reply.type}`
                    )
                );

                return false;

        }

    }

    // ==========================
    // Client Actions
    // ==========================

    switch (action) {
                    case "group_status": {

    try {

        const participants =
            groupMetadata?.participants?.map(p => p.id) || [];

        const quoted =
            message?.extendedTextMessage
                ?.contextInfo
                ?.quotedMessage;

        // TEXT STATUS

        if (!quoted) {

            await sock.sendMessage(
                jid,
                {
                    text: reply.text,
                    contextInfo: {
                        mentionedJid: participants,
                        isGroupStatus: true
                    }
                },
                {
                    statusJidList: participants
                }
            );

            await sock.sendMessage(jid, {
                text: "✅ Group Status uploaded successfully."
            });

            return true;

        }

        const media =
            await downloadQuotedMedia(quoted);

        if (!media) {

            await sock.sendMessage(jid, {
                text: "❌ Unsupported quoted media."
            });

            return true;

        }

        if (media.type === "image") {

            await sock.sendMessage(
                jid,
                {
                    image: media.buffer,
                    caption: reply.text,
                    contextInfo: {
                        mentionedJid: participants,
                        isGroupStatus: true
                    }
                },
                {
                    statusJidList: participants
                }
            );

        }

        else if (media.type === "video") {

            await sock.sendMessage(
                jid,
                {
                    video: media.buffer,
                    caption: reply.text,
                    contextInfo: {
                        mentionedJid: participants,
                        isGroupStatus: true
                    }
                },
                {
                    statusJidList: participants
                }
            );

        }

        await sock.sendMessage(jid, {
            text: "✅ Group Status uploaded successfully."
        });

        return true;

    }

    catch (err) {

        console.log(
            chalk.red(
                "GROUP STATUS ERROR:",
                err
            )
        );

        await sock.sendMessage(jid, {
            text: "❌ Failed to upload Group Status."
        });

        return true;

    }

                    }

                    case "nano_edit": {

    try {

        const quoted =
            message?.extendedTextMessage
                ?.contextInfo
                ?.quotedMessage;

        const media = await downloadQuotedMedia(quoted);

        if (!media || media.type !== "image") {

            await sock.sendMessage(jid, {
                text: "❌ Could not download that image."
            });

            return true;

        }

        const imageUrl = await uploadToCdn(media.buffer);

        if (!imageUrl) {

            await sock.sendMessage(jid, {
                text: "❌ Failed to upload the image for editing."
            });

            return true;

        }

        await sock.sendMessage(jid, {
            react: { text: "🎨", key: msg.key }
        });

        const initRes = await fetch(
            `https://omegatech-api.dixonomega.tech/api/ai/nano-banana2?prompt=${encodeURIComponent(prompt)}&image=${encodeURIComponent(imageUrl)}`
        );

        const initData = await initRes.json();

        if (!initData?.task_id) {
            throw new Error("No task ID received.");
        }

        await sock.sendMessage(jid, {
            text: "🎨 *Editing image...*\n⏳ Please wait 25-30 seconds"
        });

        const resultUrl = await pollNanoResult(initData.task_id, 20);

        await sock.sendMessage(
            jid,
            {
                image: { url: resultUrl },
                caption: reply.text
            },
            { quoted: msg }
        );

        await sock.sendMessage(jid, {
            react: { text: "✅", key: msg.key }
        });

        return true;

    } catch (err) {

        console.log(
            chalk.red("NANO EDIT ERROR:", err.message)
        );

        await sock.sendMessage(jid, {
            text: `❌ Edit failed: ${err.message}`
        });

        return true;

    }

                    }

                    case "nanopro": {

    try {

        const key = sender;

        if (!nanoProSessions.has(key)) {
            nanoProSessions.set(key, []);
        }

        const images = nanoProSessions.get(key);

        const trimmedInput = (input || "").trim();

        // ── DONE & BLEND ──
        if (/^done/i.test(trimmedInput)) {

            const finalPrompt =
                trimmedInput.replace(/^done/i, "").trim();

            if (images.length < 2) {

                await sock.sendMessage(jid, {
                    text: `⚠️ *Need at least 2 images*\nCurrently: ${images.length}/4`
                });

                return true;

            }

            if (!finalPrompt) {

                await sock.sendMessage(jid, {
                    text: "⚠️ *Use:* .nanopro done <prompt>\nExample: .nanopro done blend them together"
                });

                return true;

            }

            await sock.sendMessage(jid, {
                react: { text: "🕒", key: msg.key }
            });

            let url =
                `https://omegatech-api.dixonomega.tech/api/ai/nanobana-pro-v3?prompt=${encodeURIComponent(finalPrompt)}`;

            images.forEach((img, i) => {
                url += `&image${i + 1}=${encodeURIComponent(img)}`;
            });

            const initRes = await fetch(url);
            const initData = await initRes.json();

            if (!initData?.task_id) {
                throw new Error("No task ID.");
            }

            await sock.sendMessage(jid, {
                text: `🎨 *Blending ${images.length} images...*\n⏳ Please wait`
            });

            const resultUrl = await pollNanoResult(initData.task_id);

            await sock.sendMessage(
                jid,
                {
                    image: { url: resultUrl },
                    caption:
`╭━━━〔 🍌 *NANO PRO BLEND* 〕━━━⬣
┃ 🖼️ *Images:* ${images.length}
┃ 📝 *Prompt:* ${finalPrompt}
┃ 🐺 *Bot:* Kenya-Ultra
╰━━━━━━━━━━━━━━⬣`
                },
                { quoted: msg }
            );

            await sock.sendMessage(jid, {
                react: { text: "✅", key: msg.key }
            });

            nanoProSessions.delete(key);

            return true;

        }

        // ── COLLECT IMAGES ──
        const quoted =
            message?.extendedTextMessage
                ?.contextInfo
                ?.quotedMessage;

        let media = null;

        if (quoted?.imageMessage) {
            media = await downloadQuotedMedia(quoted);
        } else if (message?.imageMessage) {
            media = await downloadMessageMedia(msg);
        }

        if (!media || media.type !== "image") {

            await sock.sendMessage(jid, {
                text: `📸 *Send image with .nanopro*\n\nCurrent: ${images.length}/4\n\nWhen done: .nanopro done <prompt>`
            });

            return true;

        }

        if (images.length >= 4) {

            await sock.sendMessage(jid, {
                text: "❌ *Max 4 images reached*\nUse: .nanopro done <prompt>"
            });

            return true;

        }

        const link = await uploadToCdn(media.buffer);

        if (!link) {

            await sock.sendMessage(jid, {
                text: "❌ Failed to upload that image, try again."
            });

            return true;

        }

        images.push(link);

        await sock.sendMessage(jid, {
            react: { text: "📥", key: msg.key }
        });

        await sock.sendMessage(jid, {
            text: `✅ *Image added!* (${images.length}/4)\n\n${images.length === 1 ? "📸 Send another image" : images.length < 4 ? `📸 ${4 - images.length} more needed` : "🎨 Ready! Use: *.nanopro done <prompt>*"}`
        });

        return true;

    } catch (err) {

        console.log(
            chalk.red("NANOPRO ERROR:", err.message)
        );

        await sock.sendMessage(jid, {
            text: `❌ Nanopro failed: ${err.message}`
        });

        return true;

    }

                    }

                    case "recover_view_once":
        case "delete_message":
        case "moderate":
            return true;

        default:
            return false;

    }

}
            
