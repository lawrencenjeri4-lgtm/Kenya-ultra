import chalk from "chalk";
import fs from "fs";
import path from "path";

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
    message
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
                    message?.extendedTextMessage?.contextInfo?.quotedMessage;

                // ==========================
                // TEXT STATUS
                // ==========================

                if (!quoted) {

                    await sock.sendMessage(
                        jid,
                        {
                            text: reply.text || "",
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

                // ==========================
                // IMAGE STATUS
                // ==========================

                if (quoted.imageMessage) {

                    const media = await msg.quoted.download();

                    await sock.sendMessage(
                        jid,
                        {
                            image: media,
                            caption: reply.text || "",
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
                        text: "✅ Image Group Status uploaded."
                    });

                    return true;

                }

                // ==========================
                // VIDEO STATUS
                // ==========================

                if (quoted.videoMessage) {

                    const media = await msg.quoted.download();

                    await sock.sendMessage(
                        jid,
                        {
                            video: media,
                            caption: reply.text || "",
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
                        text: "✅ Video Group Status uploaded."
                    });

                    return true;

                }

                // ==========================
                // AUDIO STATUS
                // ==========================

                if (quoted.audioMessage) {

                    const media = await msg.quoted.download();

                    await sock.sendMessage(
                        jid,
                        {
                            audio: media,
                            mimetype: "audio/mp4",
                            ptt: false,
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
                        text: "✅ Audio Group Status uploaded."
                    });

                    return true;

                }

            } catch (err) {

                console.log(
                    chalk.red(
                        "GROUP STATUS ERROR:",
                        err.message
                    )
                );

                await sock.sendMessage(jid, {
                    text: "❌ Failed to upload Group Status."
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
            
